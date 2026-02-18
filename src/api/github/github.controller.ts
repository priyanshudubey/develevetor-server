import { Request, Response } from "express";
import { supabase } from "../../config/supabase";
import { GitHubService } from "../../services/github.service";

// 👇 FIX: Explicit return type guarantees strings, not undefined
const parseGitHubUrl = (
  url: string,
): { owner: string; repo: string } | null => {
  try {
    const cleanUrl = url.replace("https://github.com/", "");
    const parts = cleanUrl.split("/");

    // We need at least owner and repo parts
    if (parts.length < 2) return null;

    const owner = parts[0];
    const repo = parts[1]?.replace(".git", ""); // Remove .git if present

    // Validate they are not empty strings
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
    newContent,
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

    // Parse owner/repo
    const repoDetails = parseGitHubUrl(project.url);
    if (!repoDetails) {
      res
        .status(400)
        .json({ error: "Invalid GitHub URL in project settings." });
      return;
    }

    // 👇 TypeScript now knows these are strictly 'string'
    const { owner, repo } = repoDetails;
    const baseBranch = "main";

    // 4. SAFETY CHECK: Fetch latest file SHA
    let currentSha: string | undefined;
    try {
      const currentFile = await ghService.getFile(owner, repo, filePath);
      currentSha = currentFile.sha;
    } catch (e) {
      console.log(`File ${filePath} not found, will create new.`);
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
      content: newContent,
      message: prTitle,
      sha: currentSha || "",
      // Note: If creating a NEW file, GitHub ignores the empty SHA.
      // If updating, the SHA must match.
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

    // 6. Success
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
