import fs from "fs-extra";
import path from "path";
import simpleGit from "simple-git";
import { glob } from "glob";
import { OpenAIEmbeddings } from "@langchain/openai";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { supabase } from "../config/supabase";

const GITHUB_TOKEN = process.env.GITHUB_ACCESS_TOKEN; // We will get this dynamically
const TEMP_DIR = path.join(__dirname, "../../temp_repos");

function sanitizeContent(content: string): string {
  return content.replace(/\u0000/g, "");
}

export class IndexerService {
  // 1. CLONE REPO
  async cloneRepo(repoUrl: string, projectId: string, githubToken: string) {
    const repoPath = path.join(TEMP_DIR, projectId);

    // Clean up previous runs
    if (fs.existsSync(repoPath)) {
      await fs.remove(repoPath);
    }

    // Authenticated URL
    // Format: https://token@github.com/user/repo.git
    const authUrl = repoUrl.replace("https://", `https://${githubToken}@`);

    console.log(`Cloning ${repoUrl} into ${repoPath}...`);
    await simpleGit().clone(authUrl, repoPath, ["--depth", "1"]); // Shallow clone for speed

    return repoPath;
  }

  // 2. READ FILES
  async readFiles(repoPath: string) {
    // Find all code files, ignoring node_modules, .git, images, etc.
    const files = await glob("**/*.{ts,tsx,js,jsx,py,java,go,rs,md,json}", {
      cwd: repoPath,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**"],
      nodir: true,
    });

    console.log(`Found ${files.length} files to index.`);

    const documents = [];
    for (const file of files) {
      const content = await fs.readFile(path.join(repoPath, file), "utf-8");
      documents.push({
        path: file,
        content: sanitizeContent(content),
      });
    }

    return documents;
  }

  // 3. CHUNK & EMBED
  async indexDocuments(
    projectId: string,
    documents: { path: string; content: string }[],
  ) {
    console.log(`Chunking & Embedding ${documents.length} files...`);

    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
    });

    const embeddings = new OpenAIEmbeddings({
      modelName: "text-embedding-3-small", // Cheap & Fast
      openAIApiKey: process.env.OPENAI_API_KEY,
    });

    // Process in batches to avoid rate limits
    const BATCH_SIZE = 10;

    for (let i = 0; i < documents.length; i += BATCH_SIZE) {
      const batch = documents.slice(i, i + BATCH_SIZE);

      const insertData = [];

      for (const doc of batch) {
        // A. Split file into chunks
        const chunks = await splitter.createDocuments(
          [doc.content],
          [{ path: doc.path }],
        );

        // B. Generate Embeddings for each chunk
        for (const chunk of chunks) {
          const vector = await embeddings.embedQuery(chunk.pageContent);

          insertData.push({
            project_id: projectId,
            content: chunk.pageContent,
            metadata: chunk.metadata, // Contains file path
            embedding: vector,
          });
        }
      }

      // C. Save to Supabase
      if (insertData.length > 0) {
        const { error } = await supabase.from("documents").insert(insertData);
        if (error) console.error("Supabase Insert Error:", error);
      }

      console.log(`Indexed batch ${i / BATCH_SIZE + 1}`);
    }
  }

  // --- MAIN ENTRY POINT ---
  async processProject(
    projectId: string,
    repoUrl: string,
    githubToken: string,
  ) {
    try {
      // Step 1: Clone
      const repoPath = await this.cloneRepo(repoUrl, projectId, githubToken);

      // Step 2: Read
      const docs = await this.readFiles(repoPath);

      // Step 3: Embed & Store
      await this.indexDocuments(projectId, docs);

      // Step 4: Cleanup
      await fs.remove(repoPath);

      // Step 5: Update Status
      await supabase
        .from("projects")
        .update({ status: "READY", last_indexed_at: new Date() })
        .eq("id", projectId);

      console.log(`Project ${projectId} indexing complete!`);
    } catch (error) {
      console.error(`Indexing failed for ${projectId}:`, error);
      await supabase
        .from("projects")
        .update({ status: "ERROR" })
        .eq("id", projectId);
    }
  }
}

export const indexerService = new IndexerService();
