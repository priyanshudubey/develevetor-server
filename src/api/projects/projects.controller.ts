import { Request, Response } from "express";
import axios from "axios";
import { supabase } from "../../config/supabase";
import { indexerService } from "../../services/indexer.service";
import { incrementUsage } from "../../middlewares/rateLimit.middleware";
import { logger } from "../../config/logger";

// 1. List User's Repos from GitHub (for the selection modal)
export const listGithubRepos = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const userId = (req as any).user.id; // We need middleware to set this!

  try {
    // Get the user's GitHub token from DB
    const { data: user } = await supabase
      .from("users")
      .select("github_token")
      .eq("id", userId)
      .single();

    if (!user?.github_token) {
      res
        .status(401)
        .json({ error: "No GitHub token found. Please re-login." });
      return;
    }

    // Fetch repos from GitHub
    const response = await axios.get("https://api.github.com/user/repos", {
      headers: { Authorization: `Bearer ${user.github_token}` },
      params: {
        sort: "updated",
        per_page: 100,
        visibility: "all",
      },
    });

    // Send back simplified list
    const repos = response.data.map((repo: any) => ({
      id: repo.id,
      name: repo.full_name,
      description: repo.description,
      url: repo.html_url,
      private: repo.private,
      stars: repo.stargazers_count,
      updated_at: repo.updated_at,
    }));

    res.json({ repos });
  } catch (error) {
    logger.error("GitHub API Error:", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: "Failed to fetch repositories" });
  }
};

export const syncProject = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  const userId = (req as any).user.id;

  try {
    // 1. Verify Project Ownership
    const { data: project } = await supabase
      .from("projects")
      .select("*")
      .eq("id", id)
      .eq("user_id", userId)
      .single();

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    // 2. Fetch Token BEFORE touching the database (Safety Check)
    const { data: user } = await supabase
      .from("users")
      .select("github_token")
      .eq("id", userId)
      .single();

    if (!user?.github_token) {
      // Fail early so we don't accidentally wipe their existing vectors!
      res.status(403).json({ error: "GitHub token missing. Cannot sync." });
      return;
    }

    // 3. Wipe Old Embeddings
    await supabase.from("documents").delete().eq("project_id", id);

    // 4. Set Status to INDEXING
    await supabase
      .from("projects")
      .update({ status: "INDEXING", last_indexed_at: new Date() })
      .eq("id", id);

    // 5. Respond to Client immediately
    res.json({ success: true });

    // 6. Trigger Indexing (Background) with State Recovery
    indexerService
      .processProject(project.id, project.url, user.github_token)
      .catch(async (err) => {
        logger.error("Re-indexing failed:", {
          error: err instanceof Error ? err.message : String(err),
          userId,
          projectId: id,
        });
        await supabase
          .from("projects")
          .update({ status: "FAILED" })
          .eq("id", id);
      });
  } catch (error) {
    logger.error("Sync Project Error:", {
      error: error instanceof Error ? error.message : String(error),
      userId,
      projectId: id,
    });
    res.status(500).json({ error: "Failed to sync project" });
  }
};

// 2. Create a Project (Import)
export const createProject = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const userId = (req as any).user.id;
  const { repoId, name, url, isPrivate } = req.body;

  try {
    // .single() throws an error if it finds 0 rows. .maybeSingle() safely returns null.
    const { data: existingProject } = await supabase
      .from("projects")
      .select("*")
      .eq("user_id", userId)
      .eq("github_repo_id", repoId.toString())
      .maybeSingle();

    if (existingProject) {
      // It exists! Just un-archive it. Zero AI cost.
      const { data: restoredProject, error: restoreError } = await supabase
        .from("projects")
        .update({ status: "READY", name })
        .eq("id", existingProject.id)
        .select()
        .single();

      if (restoreError) throw restoreError;

      // Increment limits, but NO indexing needed because we kept the documents!
      await incrementUsage(userId, "project_create");
      res.json({ project: restoredProject, restoredFromCache: true });
      return;
    }

    // A. Insert Brand New Project into DB
    const { data: project, error } = await supabase
      .from("projects")
      .insert({
        user_id: userId,
        github_repo_id: repoId.toString(),
        name,
        url,
        is_private: isPrivate,
        status: "INDEXING",
      })
      .select()
      .single();

    if (error) throw error;

    await incrementUsage(userId, "project_create");

    // B. Send Response to Client immediately
    res.json({ project });

    // C. Get GitHub Token for Cloning
    const { data: user } = await supabase
      .from("users")
      .select("github_token")
      .eq("id", userId)
      .single();

    if (user?.github_token) {
      // D. Trigger Background Indexing (Only runs for truly new projects)
      indexerService
        .processProject(project.id, url, user.github_token)
        .catch((err) =>
          logger.error("Background indexing failed:", {
            error: err instanceof Error ? err.message : String(err),
            userId,
            projectId: project.id,
          }),
        );
    }
  } catch (error) {
    logger.error("Create Project Error:", {
      error: error instanceof Error ? error.message : String(error),
      userId,
    });
    res.status(500).json({ error: "Failed to create project" });
  }
};

// 3. List My Imported Projects (For Sidebar)
export const getMyProjects = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const userId = (req as any).user.id;

  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .eq("user_id", userId)
    .neq("status", "ARCHIVED")
    .order("created_at", { ascending: false });

  if (error) {
    res.status(500).json({ error: "Failed to fetch projects" });
    return;
  }

  res.json({ projects: data });
};

export const deleteProject = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  const userId = (req as any).user.id;

  try {
    const { error } = await supabase
      .from("projects")
      .update({ status: "ARCHIVED" })
      .eq("id", id)
      .eq("user_id", userId);

    if (error) throw error;

    res.json({ success: true });
  } catch (error) {
    logger.error("Delete Project Error:", {
      error: error instanceof Error ? error.message : String(error),
      userId,
    });
    res.status(500).json({ error: "Failed to delete project" });
  }
};

//4. Search Files in the Project
export const getProjectFiles = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  const { query } = req.query; // e.g. ?query=src/

  try {
    // 👇 CHANGED: We now use the Postgres RPC function for scalable search.
    // This allows searching 10,000+ files instantly without fetching them all to the server.
    const { data, error } = await supabase.rpc("search_project_files", {
      target_project_id: id,
      search_query: query ? String(query) : "", // Pass empty string if no query
    });

    if (error) {
      logger.error("RPC Search Error:", {
        error: error instanceof Error ? error.message : String(error),
        projectId: id,
      });
      throw error;
    }

    // The RPC function returns an array of objects: [{ file_path: "src/App.tsx" }, ...]
    // We map it to a simple array of strings: ["src/App.tsx", ...]
    const files = data.map((row: any) => row.file_path);

    res.json({ files });
  } catch (error) {
    logger.error("Search Files Error:", {
      error: error instanceof Error ? error.message : String(error),
      projectId: id,
    });
    res.status(500).json({ error: "Failed to search files" });
  }
};

export const getFileContent = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  const { path } = req.query;
  const userId = (req as any).user.id;

  if (!path || typeof path !== "string") {
    res.status(400).json({ error: "Path is required" });
    return;
  }

  // 1. Prepare Path Variations
  // Web/GitHub expects: "src/api/file.ts"
  const cleanPath = path.replace(/\\/g, "/");
  // Windows DB might have: "src\api\file.ts" (Double backslash for JS string)
  const windowsPath = cleanPath.replace(/\//g, "\\");

  try {
    // 2. Get Project Details
    // 👇 CHANGED: specific columns 'url' instead of 'github_url'
    const { data: project } = await supabase
      .from("projects")
      .select("url, is_private")
      .eq("id", id)
      .eq("user_id", userId) // Security check back in
      .maybeSingle();

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    // 3. Try GitHub Fetch (The "Live" version)
    // We check project.url now
    let githubSuccess = false;
    if (project.url) {
      try {
        const parts = project.url.split("/");
        const owner = parts[parts.length - 2];
        const repo = parts[parts.length - 1].replace(".git", "");

        const githubApiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${cleanPath}`;

        const headers: any = {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "DevElevator-App",
        };

        // If private, add token (if you have one in env)
        if (project.is_private && process.env.GITHUB_ACCESS_TOKEN) {
          headers.Authorization = `token ${process.env.GITHUB_ACCESS_TOKEN}`;
        }

        const response = await axios.get(githubApiUrl, { headers });

        if (response.data.content) {
          const content = Buffer.from(response.data.content, "base64").toString(
            "utf-8",
          );
          res.json({ content });
          githubSuccess = true;
          return;
        }
      } catch (ghError: any) {
        logger.warn(`[GitHub] Fetch failed: `, {
          error:
            ghError.response?.status === 404
              ? "File not found"
              : ghError.message,
          projectId: id,
          path,
        });
      }
    }

    // 4. Fallback: Search Supabase Index (The "Indexed" version)
    if (!githubSuccess) {
      logger.info("[Fallback] Searching DB for content...", {
        projectId: id,
        path,
      });

      // Match standard path OR Windows path
      const { data: dbDoc } = await supabase
        .from("documents")
        .select("content")
        .eq("project_id", id)
        // We use .or() to check both path styles
        .or(`metadata->>path.eq.${cleanPath},metadata->>path.eq.${windowsPath}`)
        .limit(1)
        .maybeSingle();

      if (dbDoc) {
        res.json({ content: `(Offline Copy)\n\n${dbDoc.content}` });
      } else {
        res.status(404).json({ error: "File content not found" });
      }
    }
  } catch (error: any) {
    logger.error("[FileView] Error:", {
      error: error instanceof Error ? error.message : String(error),
      projectId: id,
      path,
    });
    res.status(500).json({ error: "Server error retrieving file" });
  }
};

// ─── Insights Endpoints ───────────────────────────────────────────────────────

export const getProjectInsights = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  const userId = (req as any).user?.id;

  try {
    const { data: project } = await supabase
      .from("projects")
      .select("id")
      .eq("id", id)
      .eq("user_id", userId)
      .maybeSingle();

    if (!project) { res.status(404).json({ error: "Project not found" }); return; }

    const { data, error } = await supabase
      .from("file_insights")
      .select("file_path, loc, cyclomatic_complexity, max_nesting_depth, vulnerability_tags, updated_at")
      .eq("project_id", id)
      .order("cyclomatic_complexity", { ascending: false });

    if (error) {
      // Supabase PostgrestError is a plain object — serialize it properly
      const msg = error.message ?? JSON.stringify(error);
      logger.warn(`getProjectInsights DB error (table may need migration): ${msg}`, { code: error.code });
      // Return empty instead of 500 so the UI shows "No insights yet" gracefully
      res.json({ insights: [] });
      return;
    }

    res.json({ insights: data ?? [] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : JSON.stringify(err);
    logger.error(`getProjectInsights error: ${msg}`);
    res.status(500).json({ error: `Failed to fetch insights: ${msg}` });
  }
};

export const getProjectSummaries = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  const userId = (req as any).user?.id;

  try {
    const { data: project } = await supabase
      .from("projects")
      .select("id")
      .eq("id", id)
      .eq("user_id", userId)
      .maybeSingle();

    if (!project) { res.status(404).json({ error: "Project not found" }); return; }

    // Do NOT select 'embedding' — large vector, not needed on client
    const { data, error } = await supabase
      .from("file_summaries")
      .select("file_path, summary_text, file_hash")
      .eq("project_id", id);

    if (error) {
      const msg = error.message ?? JSON.stringify(error);
      logger.warn(`getProjectSummaries DB error (table may need migration): ${msg}`, { code: error.code });
      res.json({ summaries: [] });
      return;
    }

    res.json({ summaries: data ?? [] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : JSON.stringify(err);
    logger.error(`getProjectSummaries error: ${msg}`);
    res.status(500).json({ error: `Failed to fetch summaries: ${msg}` });
  }
};

