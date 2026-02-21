import { Request, Response } from "express";
import { supabase } from "../../config/supabase";
import { GitHubService } from "../../services/github.service";
import { incrementUsage } from "../../middlewares/rateLimit.middleware";

import { OpenAI } from "openai";
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

  // Use gpt-4o-mini for this. It is extremely fast, cheap, and perfect for strict formatting tasks.
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: mergePrompt }],
    temperature: 0.1, // Low temperature ensures it doesn't hallucinate extra code
  });

  const rawLlmText = response?.choices[0]?.message.content || "";
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
    // 2. Get User's GitHub Token
    const { data: userData } = await supabase
      .from("users")
      .select("github_token")
      .eq("id", user.id)
      .single();

    if (!userData?.github_token) {
      res.status(403).json({
        error: "GitHub write permission required. Please log in again.",
      });
      return;
    }

    const ghService = new GitHubService(userData.github_token);

    // 3. Get Project URL
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
    const baseBranch = "main";

    // 4. THE MERGE PIPELINE: Fetch existing file & merge
    let currentSha: string | undefined;
    let fullyMergedFileContent = newContent; // Default to the snippet (in case it's a brand new file)

    try {
      const currentFile = await ghService.getFile(owner, repo, filePath);
      currentSha = currentFile.sha;

      // If the file exists, GitHub returns base64 content. We decode it, then merge it.
      if (currentFile.content) {
        console.log(
          `[PR Workflow] Existing file found. Merging snippet invisibly...`,
        );
        const originalFileContent = currentFile.content;

        console.log(
          `[PR Workflow] Original File Lines: ${originalFileContent.split("\n").length}`,
        );

        // Let the AI merge the snippet into the full 300-line file
        fullyMergedFileContent = await performHiddenMerge(
          originalFileContent,
          newContent,
        );
        console.log(
          `[PR Workflow] Merged File Lines: ${fullyMergedFileContent.split("\n").length}`,
        );
      }
    } catch (e) {
      console.log(
        `[PR Workflow] File ${filePath} not found. Creating as a new file.`,
      );
    }

    // 5. Execution Pipeline

    // A. Create Branch
    try {
      await ghService.createBranch(owner, repo, baseBranch, branchName);
    } catch (error: any) {
      console.warn(`Branch ${branchName} creation skipped: ${error.message}`);
    }

    // B. Commit the File Change
    await ghService.updateFile({
      owner,
      repo,
      path: filePath,
      branch: branchName,
      // Pass the FULLY MERGED content here, not just the snippet
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

    // 6. Increment usage
    await incrementUsage(user.id, "pr");

    // 7. Success
    res.json({ success: true, prUrl });
  } catch (error: any) {
    console.error("PR Controller Error:", error);
    if (error.status === 422) {
      res
        .status(422)
        .json({ error: "Validation failed. PR might already exist." });
    } else {
      res.status(500).json({ error: "Failed to create PR: " + error.message });
    }
  }
};
