import { Request, Response } from "express";
import { supabase } from "../../config/supabase";
import { OpenAI } from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

export const chatWithProject = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { projectId, message } = req.body;
  const userId = (req as any).user.id;

  try {
    await supabase.from("chat_messages").insert({
      project_id: projectId,
      role: "user",
      content: message,
    });
    // 1. Generate Embedding for the User's Question
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: message,
    });
    const queryVector = embeddingResponse?.data[0]?.embedding;

    // 2. Search Supabase for similar code chunks (RAG)
    const { data: documents, error } = await supabase.rpc("match_documents", {
      query_embedding: queryVector,
      match_threshold: 0.1, // Similarity threshold (0-1)
      match_count: 5, // Top 5 most relevant chunks
      filter_project_id: projectId,
    });

    if (error) throw error;
    console.log(`Query: "${message}"`);
    console.log(`Found ${documents?.length || 0} chunks.`);

    // 3. Construct the Context Window
    // We combine the code chunks into a single string
    const contextText = documents
      ?.map(
        (doc: any) => `File: ${doc.metadata.path}\nContent:\n${doc.content}`,
      )
      .join("\n\n---\n\n");

    const systemPrompt = `
You are an expert AI software engineer. You are answering a question about a specific codebase.
Use the provided Context below to answer the user's question. 
If the answer isn't in the context, say "I don't see that in the provided code."
Always reference filenames when explaining code.

CONTEXT:
${contextText}
    `;

    // 4. Call GPT-4 to generate the answer
    const completion = await openai.chat.completions.create({
      model: "gpt-4o", // Or gpt-3.5-turbo if you want to save money
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      stream: true,
    });

    let fullAnswer = "";

    // 6. Pipe chunks to Client
    for await (const chunk of completion) {
      const text = chunk.choices[0]?.delta?.content || "";
      if (text) {
        res.write(text);
        fullAnswer += text;
      }
    }
    const sources = documents?.map((d: any) => d.metadata.path) || [];
    await supabase.from("chat_messages").insert({
      project_id: projectId,
      role: "assistant",
      content: fullAnswer,
      sources: sources,
    });

    // 5. Return the answer
    res.end();
  } catch (error) {
    console.error("Chat Error:", error);
    res.status(500).json({ error: "Failed to generate answer" });
  }
};
