import { Request, Response } from "express";
import { supabase } from "../../config/supabase";
import { callAIStream, getEmbedding, AIError, trimMessages } from "../../services/ai.service";
import { incrementUsage } from "../../middlewares/rateLimit.middleware";
import { logger } from "../../config/logger";

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
    res.status(500).json({ error: "We couldn't load your chat history at this moment. Please refresh the page." });
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

console.log("👉 FILE LOADED: chat.controller.ts");

export const chatWithProject = async (
  req: Request,
  res: Response,
): Promise<void> => {
  console.log("👉 FUNCTION EXECUTED: chatWithProject");
  const { projectId, message, selectedFiles } = req.body;
  const userId = (req as any).user?.id;
  
  let userMsgId: string | undefined;
  console.log("👉 FUNCTION EXECUTED: chatWithProject");

  try {
    // 0. Increment usage proportional to model cost (set by checkRateLimit middleware)
    if (userId) {
      const modelCost: number = (req as any).modelCost ?? 1;
      await incrementUsage(userId, "chat", modelCost);
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
    const { data: userMsg, error: insertError } = await supabase
      .from("chat_messages")
      .insert({
        project_id: projectId,
        role: "user",
        content: message,
      })
      .select("id")
      .single();

    if (insertError) throw insertError;
    userMsgId = userMsg.id;

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
    // Bypass vector search if it's a general architecture question with no specific files selected.
    const isGeneralArchitectureQuery =
      (!selectedFiles || selectedFiles.length === 0) &&
      /explain this repo|architecture|overview|how does this work/i.test(
        message,
      );

    let vectorDocs: any[] = [];
    if (!isGeneralArchitectureQuery) {
      // Always use lightweight embedding model regardless of user chat model choice
      const queryVector = await getEmbedding(message);

      const { data } = await supabase.rpc("match_documents", {
        query_embedding: queryVector,
        match_threshold: 0.1,
        match_count: 5,
        filter_project_id: projectId,
      });
      vectorDocs = data || [];
    }

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

    // 🆕 GOD-MODE SYSTEM MAP FETCH
    let systemMapText = "";
    const needsSystemMap = /explain|documentation|architecture|repo/i.test(message);
    if (needsSystemMap) {
      const { data: summaries } = await supabase
        .from("file_summaries")
        .select("file_path, summary")
        .eq("project_id", projectId)
        .limit(2000);

      if (summaries && summaries.length > 0) {
        systemMapText = summaries
          .map((s: any) => `[${s.file_path}]: ${s.summary}`)
          .join("\n");
      }
    }

    console.log("=== SYSTEM MAP CHECK ===");
console.log(systemMapText ? `✅ Map Loaded! Length: ${systemMapText.length} chars` : "❌ Map is EMPTY!");
if (systemMapText) {
  console.log("Preview:", systemMapText.substring(0, 150));
}

    // 🆕 INJECT USER INSTRUCTIONS INTO SYSTEM PROMPT
    const systemPrompt = `
You are an expert Senior Software Engineer and Technical Lead. 
You have a full map of the codebase and access to specific file contents. Your goal is to provide production-ready code, deep technical insights, and high-level architectural understanding, explain the provided codebase architecture, data flow, and business logic.

**PROJECT ARCHITECTURE (File Tree):**
${fileStructure}
${systemMapText ? `\n**COMPLETE SYSTEM MAP (File Summaries):**\n${systemMapText}\n` : ""}
**AVAILABLE CODE CONTEXT:**
${contextText}


**STRICT RULES:**
1. NO GENERIC DEFINITIONS: Do NOT explain what Node.js, Express, React, MySQL, or JWT are. The user already knows.
2. NO TAUTOLOGIES: Do NOT say 'userController manages users' or 'db.js configures the database'. That is useless.
3. FOCUS ON LOGIC & FLOW: Explain how things work. How is the JWT constructed? What middleware intercepts requests? What are the core database entities interacting in the controllers?
4. IDENTIFY THE 'GHOSTS': Point out complex areas, potential tech debt, or non-obvious logic (e.g., 'The logisticsController seems to handle both shipping and vendor assignment, which might be a tightly coupled bottleneck.').

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
- **10,000-Foot View:** (Max 3 sentences). The core business purpose of the app. Do NOT list the tech stack here.
- Use the COMPLETE SYSTEM MAP to understand how the entire application interconnects. Write a comprehensive, multi-section Documentation Guide that connects the dots between different domains (e.g., how the routes connect to specific controllers based on the summaries).
- **Architecture Diagram:** You MUST include a \`\`\`mermaid\`\`\` code block containing a flowchart (graph TD) that maps the core data flow (e.g., Client -> Router -> specific Middleware -> core Controllers -> Database).
- **Core Data Flow & Authentication:** Explain the exact journey of a request. How is the token verified? What database entities interact in the primary controllers? (e.g., "Requests hit authMiddleware which validates a bcrypt-hashed JWT before passing context to the inventoryController...").
- **Architectural Quirks & Tech Debt:** Identify complex areas, tightly coupled modules, or non-obvious logic based on the file contents.
- **Critical Execution Paths:** Name the 2-3 specific files where the heaviest business logic lives, and explain *why* they are the most critical.

*IF THE USER ASKS A SPECIFIC CODING/DEBUGGING QUESTION:*
- **TL;DR / Overview:** A 1-2 sentence summary of the solution.
- **The Explanation:** The step-by-step logic to fix or build the feature.
- **The Code:** The formatted code blocks with file path headers.
- **Next Steps:** What the user should test or do next.
${userInstructions ? `\n**USER'S PERSONALIZED CODING INSTRUCTIONS (CRITICAL):**\n${userInstructions}` : ""}
`;

console.log("=== SYSTEM PROMPT CHECK ===");
console.log(systemPrompt.includes("10,000-Foot View") ? "✅ New Prompt Active" : "❌ Old Prompt Active");

console.log("=== CONTEXT SIZE CHECK ===");
console.log(`Sending ${uniqueDocs.length} files to AI.`);
console.log("Files included in context:", sources);

    // --- STEP E: Stream Response via ai.service router ---
    // callAIStream uses callbacks to unify OpenAI / Anthropic / Google streams
    let fullAnswer = "";

    await new Promise<void>((resolve, reject) => {
      callAIStream({
        model: userModel,
        temperature: userTemperature,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message },
        ],
        stream: true,
        onChunk: (delta) => { res.write(delta); fullAnswer += delta; },
        onDone: (_full) => resolve(),
        onError: (err: AIError) => reject(err),
      });
    });

    console.log("=== SYSTEM PROMPT CHECK ===");
console.log(systemPrompt.includes("10,000-Foot View") ? "✅ New Prompt Active" : "❌ Old Prompt Active");

console.log("=== CONTEXT SIZE CHECK ===");
console.log(`Sending ${uniqueDocs.length} files to AI.`);
console.log("Files included in context:", sources);

    // Save Assistant Message
    await supabase.from("chat_messages").insert({
      project_id: projectId,
      role: "assistant",
      content: fullAnswer,
      sources: sources,
    });

    res.end();
  } catch (error) {
    // 3. Database Rollback - Delete the initial user message if the stream completely fails
    if (userMsgId) {
      try {
        await supabase.from("chat_messages").delete().eq("id", userMsgId);
      } catch (err: any) {
        logger.error("Failed to rollback user message:", { error: err.message, userMsgId });
      }
    }

    const isAIError = error instanceof AIError;
    logger.error("Chat Error:", {
      error: error instanceof Error ? error.message : String(error),
      code: isAIError ? error.code : undefined,
      retryable: isAIError ? error.retryable : undefined,
      userId: (req as any).user?.id,
    });
    if (!res.headersSent) {
      const status = isAIError && error.code === "rate_limit" ? 429
                   : isAIError && error.code === "auth"       ? 401
                   : 500;
      res.status(status).json({ error: isAIError ? error.message : "We encountered an issue while generating an answer. Please try asking your question again." });
    } else {
      // 2. Mid-Stream Error Handling
      res.write("\n\n[ERROR: The AI connection dropped mid-response. Please try again.]");
      res.end();
    }
  }
};
