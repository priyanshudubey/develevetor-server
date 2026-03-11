import { Request, Response } from "express";
import axios from "axios";
import jwt from "jsonwebtoken";
import { supabase } from "../../config/supabase";
import { logger } from "../../config/logger";

// Optional: Define what your attached user looks like to avoid 'any'
interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    plan: "FREE" | "PRO";
  };
}

// --- 1. Initiate Login ---
export const login = (req: Request, res: Response) => {
  const scopes = "user:email repo";
  const redirectUri = `https://github.com/login/oauth/authorize?client_id=${process.env.GITHUB_CLIENT_ID}&scope=${encodeURIComponent(scopes)}`;
  res.redirect(redirectUri);
};

// --- 2. Handle Callback ---
export const callback = async (req: Request, res: Response): Promise<void> => {
  const code = req.query.code as string;

  if (!code) {
    res.status(400).send("GitHub login failed because no authorization code was securely provided. Please try logging in again.");
    return;
  }

  try {
    // A. Exchange Code for Access Token with a 5-second timeout
    const tokenResponse = await axios.post(
      "https://github.com/login/oauth/access_token",
      {
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
      },
      { 
        headers: { Accept: "application/json" },
        timeout: 5000 // 5 seconds is plenty for a healthy API call
      },
    );

    const accessToken = tokenResponse.data.access_token;

    if (!accessToken) {
      // GitHub sometimes sends 200 OK with an error field inside the body
      if (tokenResponse.data.error) {
         throw new Error(`GitHub OAuth Error: ${tokenResponse.data.error_description}`);
      }
      throw new Error("Failed to get access token from GitHub");
    }

    // B. Fetch User Profile
    const userResponse = await axios.get("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 5000
    });

    const emailsResponse = await axios.get(
      "https://api.github.com/user/emails",
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 5000 },
    );

    const primaryEmail = emailsResponse.data.find((e: any) => e.primary)?.email;
    const userData = userResponse.data;

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

    if (error) throw error;

    const sessionToken = jwt.sign(
      { id: user.id, email: user.email, plan: user.plan },
      process.env.JWT_SECRET!,
      { expiresIn: "7d" },
    );

    res.cookie("auth_token", sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.redirect(`${process.env.CLIENT_URL}/dashboard`);
  } catch (error: any) {
    // 🌟 ENHANCED LOGGING
    logger.error("Auth Callback Error:", {
      message: error.message,
      code: error.code, // Useful for 'ECONNABORTED' or 'ENOTFOUND'
      response: error.response?.data,
    });
    
    // Redirect with a specific error code for the UI
    const errorType = error.code === 'ECONNABORTED' ? 'timeout' : 'auth_failed';
    res.redirect(`${process.env.CLIENT_URL}?error=${errorType}`);
  }
};

// --- 3. Get Current User ---
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

// --- 5. Get Usage ---
export const getUserUsage = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  const userId = req.user?.id;
  // 🌟 Optimization: Grab the plan directly from the authenticated user object!
  const userPlan = req.user?.plan || "FREE";

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    let { data: usage, error } = await supabase
      .from("user_usage")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw error;

    if (!usage) {
      const { data: newUsage, error: insertError } = await supabase
        .from("user_usage")
        .insert([{ user_id: userId }])
        .select()
        .single();

      if (insertError) throw insertError;
      usage = newUsage;
    }

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

    const nextResetTime = new Date(
      new Date(usage.last_reset_at).getTime() + oneDay,
    );

    const { count: activeProjectsCount } = await supabase
      .from("projects")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .neq("status", "ARCHIVED");

    // 🌟 Apply Dynamic Limits Based on the user's plan
    const isPro = userPlan === "PRO";

    res.json({
      usage: {
        chats: usage.chat_count,
        prs: usage.pr_count,
        projectCreates: usage.project_create_count,
        activeProjects: activeProjectsCount || 0,
      },
      limits: {
        chats: isPro ? 9999 : 15,
        prs: isPro ? 999 : 3,
        dailyProjectCreates: isPro ? 10 : 2,
        maxActiveProjects: isPro ? 15 : 3,
      },
      totals: {
        chats: usage.total_chats || 0,
        prs: usage.total_prs || 0,
      },
      resetAt: nextResetTime.toISOString(),
    });
  } catch (err) {
    logger.error("Get usage error:", err);
    res.status(500).json({ error: "Unable to retrieve your current usage limits. Please check again later." });
  }
};
