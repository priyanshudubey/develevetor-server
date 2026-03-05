import { Request, Response } from "express";
import { supabase } from "../../config/supabase";
import { GitHubService } from "../../services/github.service";
import { incrementUsage } from "../../middlewares/rateLimit.middleware";
import { decryptToken } from "../../utils/crypto.util";
import { callAI } from "../../services/ai.service";
import { logger } from "../../config/logger";

// Helper to extract raw code from an LLM markdown response
const extractRawCode = (llmResponse: string = ""): string => {
  if (!llmResponse) return "";

  const codeBlockRegex = /```[\w]*\n([\s\S]*?)```/;
  const match = llmResponse.match(codeBlockRegex);

  return match?.[1] ? match[1].trim() : llmResponse.trim();
};

// The Hidden Agent
const performHiddenMerge = async (
  originalCode: string,
  newSnippet: string,
): Promise<string> => {
  const mergePrompt = `
You are an expert code integration agent. 
I will provide you with the ORIGINAL FILE CONTENT and a NEW CODE SNIPPET.
Your task is to figure out exactly where the new snippet belongs in the original file, replace the old logic, and return the ENTIRE, fully updated file.

CRITICAL RULES - READ CAREFULLY:
1. You MUST return the COMPLETE file code from line 1 to the final line. 
2. ABSOLUTELY NO PLACEHOLDERS. Do not use comments like "// ... rest of the code ...", "// unchanged", or "/* previous code */". You must type out every single line of the original code.
3. If the original file has 300 lines, your output MUST have at least 300 lines.
4. Do not include any explanations, greetings, or conversational text. Output ONLY the raw code.

=== ORIGINAL FILE CONTENT ===
${originalCode}

=== NEW SNIPPET TO INTEGRATE ===
${newSnippet}
  `;

  // Always uses gpt-4o-mini for merge — fast, cheap, strict formatting. Not user-configurable.
  const rawLlmText = await callAI({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: mergePrompt }],
    temperature: 0.1,
    stream: false,
  });

  return extractRawCode(rawLlmText);
};

const parseGitHubUrl = (
  url: string,
): { owner: string; repo: string } | null => {
  try {
    const cleanUrl = url.replace("https://github.com/", "");
    const parts = cleanUrl.split("/");

    if (parts.length < 2) return null;

    const owner = parts[0];
    const repo = parts[1]?.replace(".git", "");

    if (!owner || !repo) return null;

    return { owner, repo };
  } catch (e) {
    return null;
  }
};

export const createPullRequest = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const {
    projectId,
    filePath,
    newContent, // This is the AI Snippet from the frontend
    prTitle,
    prDescription,
    branchName,
  } = req.body;

  // 1. Get User ID
  const user = (req as any).user;
  if (!user || !user.id) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    // 2. THE VAULT EXTRACTION
    // Fetch the encrypted token from the new isolated integrations table
    const { data: integrationData } = await supabase
      .from("user_integrations")
      .select("github_token")
      .eq("user_id", user.id)
      .single();

    if (!integrationData?.github_token) {
      res.status(403).json({
        error:
          "GitHub write permission required. Please connect your account in Settings.",
      });
      return;
    }

    // 3. THE DECRYPTION
    // Unlock the token in server memory so it can be used for this specific request
    const decryptedToken = decryptToken(integrationData.github_token);

    // Initialize the GitHub service acting explicitly on behalf of THIS user
    const ghService = new GitHubService(decryptedToken);

    // 4. Get Project URL
    const { data: project } = await supabase
      .from("projects")
      .select("url")
      .eq("id", projectId)
      .single();

    if (!project || !project.url) {
      res.status(404).json({ error: "Project URL not found" });
      return;
    }

    const repoDetails = parseGitHubUrl(project.url);
    if (!repoDetails) {
      res
        .status(400)
        .json({ error: "Invalid GitHub URL in project settings." });
      return;
    }

    const { owner, repo } = repoDetails;
    const baseBranch = "main"; // Or dynamically fetch from user_preferences if you added that!

    // 5. THE MERGE PIPELINE: Fetch existing file & merge
    let currentSha: string | undefined;
    let fullyMergedFileContent = newContent;

    try {
      const currentFile = await ghService.getFile(owner, repo, filePath);
      currentSha = currentFile.sha;

      if (currentFile.content) {
        logger.info(
          `[PR Workflow] Existing file found. Merging snippet invisibly...`,
          { filePath, projectId },
        );
        const originalFileContent = currentFile.content;

        fullyMergedFileContent = await performHiddenMerge(
          originalFileContent,
          newContent,
        );

        logger.info(
          `[PR Workflow] Merged File Lines: ${fullyMergedFileContent.split("\n").length}`,
          { filePath, projectId },
        );
      }
    } catch (e) {
      logger.info(
        `[PR Workflow] File ${filePath} not found. Creating as a new file.`,
        { filePath, projectId },
      );
    }

    // 6. Execution Pipeline

    // A. Create Branch
    try {
      await ghService.createBranch(owner, repo, baseBranch, branchName);
    } catch (error: any) {
      logger.warn(`Branch ${branchName} creation skipped: ${error.message}`, {
        branchName,
        projectId,
      });
    }

    // B. Commit the File Change
    await ghService.updateFile({
      owner,
      repo,
      path: filePath,
      branch: branchName,
      content: fullyMergedFileContent,
      message: prTitle,
      sha: currentSha || "",
    });

    // C. Open the Pull Request
    const prUrl = await ghService.createPullRequest({
      owner,
      repo,
      title: prTitle,
      body: prDescription,
      head: branchName,
      base: baseBranch,
    });

    // 7. Increment usage
    await incrementUsage(user.id, "pr");

    // 8. Success
    res.json({ success: true, prUrl });
  } catch (error: any) {
    logger.error("PR Controller Error:", {
      error: error instanceof Error ? error.message : String(error),
      projectId,
    });
    if (error.status === 422) {
      res
        .status(422)
        .json({ error: "Validation failed. PR might already exist." });
    } else {
      res.status(500).json({ error: "Failed to create PR: " + error.message });
    }
  }
};
