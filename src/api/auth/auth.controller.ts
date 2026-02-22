import { Request, Response } from "express";
import axios from "axios";
import jwt from "jsonwebtoken";
import { supabase } from "../../config/supabase";
import { logger } from "../../config/logger";

// --- 1. Initiate Login ---
// Redirects the user to GitHub's consent screen
export const login = (req: Request, res: Response) => {
  const scopes = "user:email repo";

  const redirectUri = `https://github.com/login/oauth/authorize?client_id=${process.env.GITHUB_CLIENT_ID}&scope=${encodeURIComponent(scopes)}`;

  res.redirect(redirectUri);
};

// --- 2. Handle Callback ---
// GitHub redirects back here with a "code". We exchange it for a token.
export const callback = async (req: Request, res: Response): Promise<void> => {
  const code = req.query.code as string;

  if (!code) {
    res.status(400).send("No code provided by GitHub");
    return;
  }

  try {
    // A. Exchange Code for Access Token
    const tokenResponse = await axios.post(
      "https://github.com/login/oauth/access_token",
      {
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
      },
      { headers: { Accept: "application/json" } },
    );

    const accessToken = tokenResponse.data.access_token;

    if (!accessToken) {
      throw new Error("Failed to get access token from GitHub");
    }

    // B. Fetch User Profile
    const userResponse = await axios.get("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    // C. Fetch Email (Privately if needed)
    const emailsResponse = await axios.get(
      "https://api.github.com/user/emails",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );

    const primaryEmail = emailsResponse.data.find((e: any) => e.primary)?.email;
    const userData = userResponse.data;

    // D. Upsert User into Supabase
    // "Upsert" means: Insert if new, Update if exists.
    const { data: user, error } = await supabase
      .from("users")
      .upsert(
        {
          github_id: userData.id.toString(),
          email: primaryEmail || userData.email,
          name: userData.name || userData.login,
          avatar_url: userData.avatar_url,
          github_token: accessToken,
          last_login: new Date().toISOString(),
        },
        { onConflict: "github_id" },
      )
      .select()
      .single();

    if (error) {
      logger.error("Supabase Error:", {
        error: error instanceof Error ? error.message : String(error),
        githubId: userData.id,
      });
      throw error;
    }

    // E. Generate JWT (Our Session Token)
    const sessionToken = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET!,
      { expiresIn: "7d" },
    );

    // F. Set HTTP-Only Cookie & Redirect
    res.cookie("auth_token", sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production", // False in localhost
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.redirect("http://localhost:5173/dashboard"); // Redirect to Frontend
  } catch (error) {
    logger.error("Auth Callback Error:", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.redirect("http://localhost:5173?error=auth_failed");
  }
};

// --- 3. Get Current User ---
// Used by the frontend to check if logged in
export const getMe = async (req: Request, res: Response): Promise<void> => {
  const token = req.cookies.auth_token;

  if (!token) {
    res.status(401).json({ user: null });
    return;
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;

    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("id", decoded.id)
      .single();

    if (error || !user) {
      res.clearCookie("auth_token");
      res.status(401).json({ user: null });
      return;
    }

    res.json({ user });
  } catch (e) {
    res.clearCookie("auth_token");
    res.status(401).json({ user: null });
  }
};

// --- 4. Logout ---
export const logout = (req: Request, res: Response) => {
  res.clearCookie("auth_token");
  res.json({ success: true });
};

export const getUserUsage = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const userId = (req as any).user?.id;

  try {
    let { data: usage, error } = await supabase
      .from("user_usage")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw error;

    // Self-Healing: If no row exists, create one
    if (!usage) {
      const { data: newUsage, error: insertError } = await supabase
        .from("user_usage")
        .insert([{ user_id: userId }])
        .select()
        .single();

      if (insertError) throw insertError;
      usage = newUsage;
    }

    // Check for 24h reset
    const now = new Date();
    const lastReset = new Date(usage.last_reset_at);
    const oneDay = 24 * 60 * 60 * 1000;

    if (now.getTime() - lastReset.getTime() > oneDay) {
      const { data: resetData, error: resetError } = await supabase
        .from("user_usage")
        .update({
          chat_count: 0,
          pr_count: 0,
          project_create_count: 0,
          last_reset_at: now.toISOString(),
        })
        .eq("user_id", userId)
        .select()
        .single();

      if (!resetError) usage = resetData;
    }

    // Calculate the next reset time to send to the frontend
    const nextResetTime = new Date(
      new Date(usage.last_reset_at).getTime() + oneDay,
    );

    res.json({
      usage: {
        chats: usage.chat_count,
        prs: usage.pr_count,
        projectCreates: usage.project_create_count,
      },
      limits: {
        chats: 15,
        prs: 3,
        projectCreates: 2,
      },
      resetAt: nextResetTime.toISOString(),
    });
  } catch (err) {
    logger.error("Get usage error:", {
      error: err instanceof Error ? err.message : String(err),
      userId,
    });
    res.status(500).json({ error: "Failed to fetch usage limits" });
  }
};
