import { Request, Response } from "express";
import { supabase } from "../../config/supabase";
import { OpenAI } from "openai"; // Ensure this matches your export
import { incrementUsage } from "../../middlewares/rateLimit.middleware";

// Ensure apiKey presence before proceeding
if (!process.env.OPENAI_API_KEY) {
  throw new Error("Missing OpenAI API Key.");
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Type-safe response and request, consider extending the Request interface
interface CustomRequest extends Request {
  user?: { id?: string };
}

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

    if (error) throw new Error(`Failed to fetch chat messages: ${error.message}`);

    res.json(data);
  } catch (error: any) {
    console.error("Get History Error:", error);
    res.status(500).json({ error: error.message || "Failed to fetch history" });
  }
};

// Placeholder for the rest of the function, same structure with improvements...