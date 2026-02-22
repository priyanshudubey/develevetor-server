// src/api/users/users.controller.ts
import { Request, Response } from "express";
import { supabase } from "../../config/supabase";
import { encryptToken } from "../../utils/crypto.util";
import { logger } from "../../config/logger";

// --- AI PREFERENCES ---

export const getPreferences = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const userId = (req as any).user.id;

  try {
    const { data, error } = await supabase
      .from("user_preferences")
      .select("ai_model, ai_temperature, ai_instructions, theme")
      .eq("user_id", userId)
      .single();

    if (error && error.code !== "PGRST116") {
      throw error;
    }

    // If no data exists yet, send back our database defaults
    res.json({
      model: data?.ai_model || "gpt-4o",
      temperature: data?.ai_temperature ?? 0.3,
      instructions: data?.ai_instructions || "",
      theme: data?.theme || "dark",
    });
  } catch (error: any) {
    logger.error("Fetch Preferences Error:", error);
    res.status(500).json({ error: "Failed to fetch preferences" });
  }
};

export const updatePreferences = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const userId = (req as any).user.id;
  const { model, temperature, instructions, theme } = req.body;

  try {
    const { error } = await supabase.from("user_preferences").upsert({
      user_id: userId,
      ai_model: model,
      ai_temperature: temperature,
      ai_instructions: instructions,
      theme: theme,
      updated_at: new Date(),
    });

    if (error) throw error;
    res.json({ success: true });
  } catch (error: any) {
    logger.error("Update Preferences Error:", error);
    res.status(500).json({ error: "Failed to update preferences" });
  }
};

// --- GITHUB INTEGRATION ---

export const updateGithubToken = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const userId = (req as any).user.id;
  const { token } = req.body;

  if (!token) {
    res.status(400).json({ error: "Token is required" });
    return;
  }

  try {
    // 1. Encrypt the token before it ever touches the database!
    const encryptedToken = encryptToken(token);

    // 2. Save to the vault
    const { error } = await supabase.from("user_integrations").upsert({
      user_id: userId,
      github_token: encryptedToken,
      updated_at: new Date(),
    });

    if (error) throw error;

    logger.info(`GitHub token encrypted and vaulted for user: ${userId}`);
    res.json({ success: true });
  } catch (error: any) {
    logger.error("Vault GitHub Token Error:", error);
    res.status(500).json({ error: "Failed to securely save token" });
  }
};

export const getIntegrationStatus = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const userId = (req as any).user.id;

  try {
    const { data, error } = await supabase
      .from("user_integrations")
      .select("github_token")
      .eq("user_id", userId)
      .single();

    if (error && error.code !== "PGRST116") throw error;

    // Never send the token back to the frontend. Just a boolean confirming it exists.
    res.json({ hasGithubToken: !!data?.github_token });
  } catch (error: any) {
    logger.error("Check Integration Error:", error);
    res.status(500).json({ error: "Failed to check integrations" });
  }
};

export const getUsageStats = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const userId = (req as any).user.id;

  try {
    // 1. Fetch daily usage counts
    const { data: usage } = await supabase
      .from("user_usage")
      .select("chat_count, pr_count, project_create_count, last_reset_at")
      .eq("user_id", userId)
      .single();

    // 2. Fetch active projects count
    const { count: activeProjects } = await supabase
      .from("projects")
      .select("*", { count: "exact", head: true })
      .neq("status", "ARCHIVED")
      .eq("user_id", userId);

    // Hardcoded limits matching your middleware
    const limits = {
      chats: 15,
      prs: 3,
      projects: 3,
    };

    res.json({
      usage: {
        chats: usage?.chat_count || 0,
        prs: usage?.pr_count || 0,
        projects: activeProjects || 0,
      },
      limits,
      resetAt: usage?.last_reset_at
        ? new Date(
            new Date(usage.last_reset_at).getTime() + 24 * 60 * 60 * 1000,
          ).toISOString()
        : null,
    });
  } catch (error) {
    logger.error("Fetch Usage Error:", error);
    res.status(500).json({ error: "Failed to fetch usage statistics" });
  }
};
