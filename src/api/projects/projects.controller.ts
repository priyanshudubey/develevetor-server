import { Request, Response } from "express";
import axios from "axios";
import { supabase } from "../../config/supabase";
import { indexerService } from "../../services/indexer.service";

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
    console.error("GitHub API Error:", error);
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

    // 2. Wipe Old Embeddings (Crucial!)
    // If we don't do this, the AI will find two versions of every file.
    await supabase.from("documents").delete().eq("project_id", id);

    // 3. Set Status to INDEXING
    await supabase
      .from("projects")
      .update({ status: "INDEXING", last_indexed_at: new Date() })
      .eq("id", id);

    // 4. Respond to Client immediately
    res.json({ success: true });

    // 5. Get GitHub Token & Trigger Indexing (Background)
    const { data: user } = await supabase
      .from("users")
      .select("github_token")
      .eq("id", userId)
      .single();

    if (user?.github_token) {
      indexerService
        .processProject(project.id, project.url, user.github_token)
        .catch((err) => console.error("Re-indexing failed:", err));
    }
  } catch (error) {
    console.error("Sync Project Error:", error);
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
    // A. Insert Project into DB
    const { data: project, error } = await supabase
      .from("projects")
      .insert({
        user_id: userId,
        github_repo_id: repoId.toString(),
        name,
        url,
        is_private: isPrivate,
        status: "INDEXING", // Set immediately to INDEXING
      })
      .select()
      .single();

    if (error) throw error;

    // B. Send Response to Client immediately (Don't wait for indexing)
    res.json({ project });

    // C. Get GitHub Token for Cloning
    const { data: user } = await supabase
      .from("users")
      .select("github_token")
      .eq("id", userId)
      .single();

    if (user?.github_token) {
      // D. Trigger Background Indexing
      // We do NOT await this, so the UI doesn't freeze
      indexerService
        .processProject(project.id, url, user.github_token)
        .catch((err) => console.error("Background indexing failed:", err));
    }
  } catch (error) {
    console.error("Create Project Error:", error);
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
    // 1. Delete Vectors (The "Brain" of the project)
    // We explicitly delete these to ensure no "phantom" search results remain.
    await supabase.from("documents").delete().eq("project_id", id);

    // 2. Delete the Project (Cascade will handle chat_messages automatically)
    const { error } = await supabase
      .from("projects")
      .delete()
      .eq("id", id)
      .eq("user_id", userId); // Security: Ensure user owns the project

    if (error) throw error;

    res.json({ success: true });
  } catch (error) {
    console.error("Delete Project Error:", error);
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
      console.error("RPC Search Error:", error);
      throw error;
    }

    // The RPC function returns an array of objects: [{ file_path: "src/App.tsx" }, ...]
    // We map it to a simple array of strings: ["src/App.tsx", ...]
    const files = data.map((row: any) => row.file_path);

    res.json({ files });
  } catch (error) {
    console.error("Search Files Error:", error);
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
        console.warn(`[GitHub] Fetch failed: ${ghError.message}`);
      }
    }

    // 4. Fallback: Search Supabase Index (The "Indexed" version)
    if (!githubSuccess) {
      console.log("[Fallback] Searching DB for content...");

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
    console.error("[FileView] Error:", error.message);
    res.status(500).json({ error: "Server error retrieving file" });
  }
};
