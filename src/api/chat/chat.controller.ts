import { Request, Response } from "express";
import { supabase } from "../../config/supabase";
import { OpenAI } from "openai"; // Ensure this matches your export
import { incrementUsage } from "../../middlewares/rateLimit.middleware";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 1. GET CHAT HISTORY
export const getChatHistory = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { projectId } = req.params;

  try {
    const { data, error } = await supabase
      .from("chat_messages")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true }); // Oldest first

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error("Get History Error:", error);
    res.status(500).json({ error: "Failed to fetch history" });
  }
};

// --- HELPER: Generate ASCII Tree ---
const generateFileTree = (paths: string[]) => {
  const tree: any = {};

  // 1. Build the object structure
  paths.forEach((path) => {
    const parts = path.split("/");
    let current = tree;
    parts.forEach((part) => {
      if (!current[part]) current[part] = {};
      current = current[part];
    });
  });

  // 2. Recursive function to print the tree string
  const buildString = (node: any, prefix = "") => {
    let result = "";
    const keys = Object.keys(node).sort(); // Sort for consistency

    keys.forEach((key, index) => {
      const isLast = index === keys.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";

      const isFile = Object.keys(node[key]).length === 0;

      result += `${prefix}${connector}${key}\n`;

      if (!isFile) {
        result += buildString(node[key], prefix + childPrefix);
      }
    });
    return result;
  };

  return buildString(tree);
};

// 2. CHAT WITH PROJECT (RAG + Context Injection)
export const chatWithProject = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { projectId, message, selectedFiles } = req.body;
  const userId = (req as any).user?.id;

  try {
    // 0. Increment usage before stream starts
    if (userId) {
      await incrementUsage(userId, "chat");
    }

    // 1. Save USER message immediately
    await supabase.from("chat_messages").insert({
      project_id: projectId,
      role: "user",
      content: message,
    });

    // --- STEP A: Fetch File Map (The "Brain") ---
    const { data: filePaths } = await supabase
      .from("documents")
      .select("metadata->>path")
      .eq("project_id", projectId)
      .limit(2000);

    const allPaths = filePaths ? filePaths.map((f: any) => f.path) : [];

    // Use the Tree Generator for better AI understanding
    const fileStructure =
      allPaths.length > 0 ? generateFileTree(allPaths) : "(No files found)";

    // --- STEP B: Resolve "Context Files" ---
    // Priority: Selected > Core (package.json) > Vector

    let targetPaths: string[] = [];

    // 1. Explicit Selection
    if (selectedFiles && selectedFiles.length > 0) {
      targetPaths.push(...selectedFiles);
    }

    // 2. Implicit Core Files (Only if explicit context is low)
    // Always try to include package.json or main entries if user didn't select many files
    if (targetPaths.length < 3) {
      const corePatterns = [
        "package.json",
        "tsconfig.json",
        "src/index",
        "src/App",
        "src/main",
        "server.ts",
        "main.go",
      ];
      // Find paths that fuzzy match core patterns
      const corePaths = allPaths
        .filter((p) => corePatterns.some((core) => p.includes(core)))
        .slice(0, 3);

      targetPaths.push(...corePaths);
    }

    // Deduplicate paths before fetching
    targetPaths = [...new Set(targetPaths)];

    // Fetch Content for these Target Files
    let explicitDocs: any[] = [];
    if (targetPaths.length > 0) {
      const { data } = await supabase
        .from("documents")
        .select("content, metadata")
        .eq("project_id", projectId)
        .in("metadata->>path", targetPaths);
      explicitDocs = data || [];
    }

    // --- STEP C: Vector Search (The "Specifics") ---
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: message,
    });
    const queryVector = embeddingResponse?.data[0]?.embedding;

    const { data: vectorDocs } = await supabase.rpc("match_documents", {
      query_embedding: queryVector,
      match_threshold: 0.1, // Loose threshold to catch more potential matches
      match_count: 5,
      filter_project_id: projectId,
    });

    // --- STEP D: Combine & Deduplicate Context ---
    const allDocs = [...explicitDocs, ...(vectorDocs || [])];

    // Deduplicate docs by path (Video Search might find same file as Core)
    const uniqueDocsMap = new Map();
    allDocs.forEach((doc) => uniqueDocsMap.set(doc.metadata.path, doc));
    const uniqueDocs = Array.from(uniqueDocsMap.values());

    // Prepare Sources Header
    const sources = uniqueDocs.map((d: any) => d.metadata.path);

    // Send Headers BEFORE streaming
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("x-sources", JSON.stringify(sources));

    // Build the Context String
    const contextText = uniqueDocs
      .map((doc: any) => `\n--- FILE: ${doc.metadata.path} ---\n${doc.content}`)
      .join("\n");

    const systemPrompt = `
You are an expert Senior Software Engineer.
You have a full map of the codebase and access to specific file contents.

**PROJECT ARCHITECTURE (File Tree):**
${fileStructure}

**AVAILABLE CODE CONTEXT:**
${contextText}

**INSTRUCTIONS:**
1. **Analyze the Tree:** Use the "File Tree" to understand the project structure (e.g., "I see a /routes folder, so this is likely an Express app").
2. **Use the Context:** Answer the user's question using the provided "Code Context".
3. **Be Honest:** If the answer requires a file that is in the "Tree" but NOT in the "Context", say: "I see a file named 'src/utils/auth.ts' in the tree which likely contains the answer. Could you select that file?"
4. **Assume React/Node unless seen otherwise.**
5. **Keep answers concise and code-focused.**
6. **FILE TREES:** You MUST wrap file trees in a markdown code block using the 'text' language. 
EXPECTED FORMAT:
\`\`\`text
├── src/
│   └── index.js
\`\`\`
NEVER output a file tree as plain text.

IMPORTANT: When generating code for a specific file, ALWAYS start the code block with a comment specifying the full file path, like this: // File: src/components/App.tsx or # File: scripts/deploy.py.
`;

    // --- STEP E: Stream Response ---
    const stream = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      stream: true,
    });

    let fullAnswer = "";

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || "";
      if (text) {
        res.write(text);
        fullAnswer += text;
      }
    }

    // Save Assistant Message
    await supabase.from("chat_messages").insert({
      project_id: projectId,
      role: "assistant",
      content: fullAnswer,
      sources: sources,
    });

    res.end();
  } catch (error) {
    console.error("Chat Error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to generate answer" });
    } else {
      res.end();
    }
  }
};
