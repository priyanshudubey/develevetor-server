import { Request, Response } from "express";
import axios from "axios";
import jwt from "jsonwebtoken";
import { supabase } from "../../config/supabase";

// --- 1. Initiate Login ---
// Redirects the user to GitHub's consent screen
export const login = (req: Request, res: Response) => {
  const redirectUri = `https://github.com/login/oauth/authorize?client_id=${process.env.GITHUB_CLIENT_ID}&scope=user:email`;
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
      console.error("Supabase Error:", error);
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
    console.error("Auth Callback Error:", error);
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
