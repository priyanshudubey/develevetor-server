import { Request, Response } from "express";
import { supabase } from "../../config/supabase";
import { OpenAI } from "openai";
import { incrementUsage } from "../../middlewares/rateLimit.middleware";
import { logger } from "../../config/logger";

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
      .order("created_at", { ascending: true });

    if (error) throw error;

    res.json(data);
  } catch (error) {
    logger.error("Get History Error:", {
      error: error instanceof Error ? error.message : String(error),
      userId: (req as any).user?.id,
    });
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
// ... your existing imports and generateFileTree helper ...

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

    // 🆕 FETCH USER PREFERENCES (Defaults applied if not found)
    let userModel = "gpt-4o";
    let userTemperature = 0.3;
    let userInstructions = "";

    if (userId) {
      const { data: prefs } = await supabase
        .from("user_preferences")
        .select("ai_model, ai_temperature, ai_instructions")
        .eq("user_id", userId)
        .single();

      if (prefs) {
        userModel = prefs.ai_model || "gpt-4o";
        userTemperature = Number(prefs.ai_temperature) ?? 0.3;
        userInstructions = prefs.ai_instructions || "";
      }
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
    const fileStructure =
      allPaths.length > 0 ? generateFileTree(allPaths) : "(No files found)";

    // --- STEP B: Resolve "Context Files" ---
    let targetPaths: string[] = [];
    if (selectedFiles && selectedFiles.length > 0) {
      targetPaths.push(...selectedFiles);
    }
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
      const corePaths = allPaths
        .filter((p) => corePatterns.some((core) => p.includes(core)))
        .slice(0, 3);
      targetPaths.push(...corePaths);
    }
    targetPaths = [...new Set(targetPaths)];

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
    // 🆕 Use a lightweight model for embeddings to save money, regardless of what the user selected for chat
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: message,
    });
    const queryVector = embeddingResponse?.data[0]?.embedding;

    const { data: vectorDocs } = await supabase.rpc("match_documents", {
      query_embedding: queryVector,
      match_threshold: 0.1,
      match_count: 5,
      filter_project_id: projectId,
    });

    // --- STEP D: Combine & Deduplicate Context ---
    const allDocs = [...explicitDocs, ...(vectorDocs || [])];
    const uniqueDocsMap = new Map();
    allDocs.forEach((doc) => uniqueDocsMap.set(doc.metadata.path, doc));
    const uniqueDocs = Array.from(uniqueDocsMap.values());

    const sources = uniqueDocs.map((d: any) => d.metadata.path);

    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("x-sources", JSON.stringify(sources));

    const contextText = uniqueDocs
      .map((doc: any) => `\n--- FILE: ${doc.metadata.path} ---\n${doc.content}`)
      .join("\n");

    // 🆕 INJECT USER INSTRUCTIONS INTO SYSTEM PROMPT
    const systemPrompt = `
You are an expert Senior Software Engineer and Technical Lead. 
You have a full map of the codebase and access to specific file contents. Your goal is to provide production-ready code, deep technical insights, and high-level architectural understanding.

**PROJECT ARCHITECTURE (File Tree):**
${fileStructure}

**AVAILABLE CODE CONTEXT:**
${contextText}

**CORE BEHAVIORS & METHODOLOGY:**
1. Analyze First: Always use the "File Tree" to infer the tech stack, domain boundaries, and architecture before answering.
2. Repository Overviews: If the user asks to explain the repository, project, or architecture, analyze the file tree and available config files (like package.json) to provide a top-down summary of how the application is structured.
3. Explain the 'Why': Don't just dump code. Briefly explain your architectural decisions, why a specific pattern was chosen, or how the data flows.
4. Be Honest & Precise: If the answer requires a file that is in the "Tree" but NOT in the "Context", DO NOT hallucinate. Explicitly state: "I see a file named 'src/path/to/file.ts' in the tree. Please select that file for me to give a complete answer."
5. Best Practices: Ensure all provided code adheres to modern best practices regarding security, performance, and clean code principles.

**FORMATTING & OUTPUT RULES:**
1. **Code Blocks:** All code must be wrapped in standard markdown code blocks with the correct language tag.
2. **File Path Headers:** When generating or modifying code for a specific file, ALWAYS start the code block with a comment specifying the exact file path (e.g., \`// File: src/components/Button.tsx\`).
3. **Targeted Edits:** If modifying an existing file, do not rewrite the entire file. Provide the specific snippet to be changed with enough surrounding context to locate it.
4. **File Trees:** When asked to generate a file tree or directory structure, YOU MUST wrap it in a markdown code block using the 'text' language. 
   EXPECTED FORMAT:
   \`\`\`text
   ├── src/
   │   └── index.js
   \`\`\`
   NEVER output a file tree as plain text.

**RESPONSE STRUCTURES:**
Choose the appropriate structure based on the user's prompt:

*IF THE USER ASKS FOR A REPOSITORY/PROJECT EXPLANATION:*
- **High-Level Purpose:** What this application likely does based on its naming and structure.
- **Inferred Tech Stack:** The frameworks, languages, and tools being used.
- **Architecture Breakdown:** A clear explanation of what the key directories handle (e.g., "The \`/api\` folder manages backend routes, while \`/services\` handles business logic").
- **Key Workflows:** How data likely moves through the system.
- **Where to Start:** The 2-3 most important files the user should look at to understand the core logic.

*IF THE USER ASKS A SPECIFIC CODING/DEBUGGING QUESTION:*
- **TL;DR / Overview:** A 1-2 sentence summary of the solution.
- **The Explanation:** The step-by-step logic to fix or build the feature.
- **The Code:** The formatted code blocks with file path headers.
- **Next Steps:** What the user should test or do next.
${userInstructions ? `\n**USER'S PERSONALIZED CODING INSTRUCTIONS (CRITICAL):**\n${userInstructions}` : ""}
`;

    // --- STEP E: Stream Response ---
    // 🆕 PASS THE USER'S SELECTED MODEL AND TEMPERATURE
    const stream = await openai.chat.completions.create({
      model: userModel, // dynamically set!
      temperature: userTemperature, // dynamically set!
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
    logger.error("Chat Error:", {
      error: error instanceof Error ? error.message : String(error),
      userId: (req as any).user?.id,
    });
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to generate answer" });
    } else {
      res.end();
    }
  }
};
