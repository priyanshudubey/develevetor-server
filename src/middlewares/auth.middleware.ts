import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { supabase } from "../config/supabase";

export const requireAuth = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const token = req.cookies.auth_token;

  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;

    const { data: user, error } = await supabase
      .from("users")
      .select("id, email, plan")
      .eq("id", decoded.id)
      .single();

    if (error || !user) {
      res.clearCookie("auth_token");
      res.status(401).json({ error: "User not found in database" });
      return;
    }

    (req as any).user = user;

    next();
  } catch (error) {
    res.status(401).json({ error: "Invalid token" });
  }
};
