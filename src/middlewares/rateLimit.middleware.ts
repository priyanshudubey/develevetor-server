import { Request, Response, NextFunction } from "express";
import { supabase } from "../config/supabase";

// Define limits in one place so they are easy to tweak
const LIMITS = {
  FREE: {
    CHATS_PER_DAY: 15,
    PRS_PER_DAY: 3,
    PROJECT_CREATES_PER_DAY: 2,
    MAX_ACTIVE_PROJECTS: 3,
  },
};

const ADMIN_USER_IDS = [
  "your-uuid-goes-here-e.g-123e4567-e89b...",
  process.env.ADMIN_USER_ID, // Support environment variable
];

type LimitType = "chat" | "pr" | "project_create";

export const checkRateLimit = (type: LimitType) => {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const userId = (req as any).user?.id;

    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // if (ADMIN_USER_IDS.includes(userId)) {
    //   console.log(`[RateLimit] Admin bypass for user: ${userId}`);

    //   // We still need to attach a dummy usage row so the controller doesn't crash
    //   // if it tries to access req.usageRow later.
    //   (req as any).usageRow = {
    //     chat_count: 0,
    //     pr_count: 0,
    //     project_create_count: 0,
    //   };

    //   return next();
    // }

    try {
      // 1. Fetch current usage
      const { data: usage, error } = await supabase
        .from("user_usage")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) {
        console.error("Rate Limit Error: Could not fetch usage", error);
        // Fail open or closed? Let's fail safe (allow) but log it, or block.
        // For beta, let's block to be safe.
        res.status(500).json({ error: "Could not verify usage limits" });
        return;
      }

      let currentUsage = usage;

      if (!currentUsage) {
        console.log(`Creating missing usage row for user: ${userId}`);
        const { data: newUsage, error: insertError } = await supabase
          .from("user_usage")
          .insert([{ user_id: userId }])
          .select()
          .single();

        if (insertError || !newUsage) {
          console.error(
            "Rate Limit Error: Could not create usage row",
            insertError,
          );
          res.status(500).json({ error: "Could not initialize usage limits" });
          return;
        }
        currentUsage = newUsage; // Now currentUsage is guaranteed to be an object!
      }

      // 2. Check if we need to RESET (New Day)
      const now = new Date();
      const lastReset = new Date(currentUsage.last_reset_at);
      const oneDay = 24 * 60 * 60 * 1000;

      if (now.getTime() - lastReset.getTime() > oneDay) {
        // It's been more than 24h, reset counters!
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

        if (!resetError) {
          currentUsage = resetData;
        }
      }

      const nextResetTime = new Date(lastReset.getTime() + oneDay);

      // 3. Check Specific Limits
      if (type === "chat") {
        if (currentUsage.chat_count >= LIMITS.FREE.CHATS_PER_DAY) {
          res.status(429).json({
            error: `Daily chat limit reached (${LIMITS.FREE.CHATS_PER_DAY}/day).`,
            resetAt: nextResetTime.toISOString(),
          });
          return;
        }
      } else if (type === "pr") {
        if (currentUsage.pr_count >= LIMITS.FREE.PRS_PER_DAY) {
          res.status(429).json({
            error: `Daily PR limit reached (${LIMITS.FREE.PRS_PER_DAY}/day).`,
            resetAt: nextResetTime.toISOString(),
          });
          return;
        }
      } else if (type === "project_create") {
        // Check Daily Creations
        if (
          currentUsage.project_create_count >=
          LIMITS.FREE.PROJECT_CREATES_PER_DAY
        ) {
          res.status(429).json({
            error: `You can only create ${LIMITS.FREE.PROJECT_CREATES_PER_DAY} projects per day.`,
            resetAt: nextResetTime.toISOString(),
          });
          return;
        }

        // Check Total Active Projects (Static Limit)
        // Note: You need to make sure you update 'active_projects_count' when deleting projects too!
        // Or simply count the rows in the 'projects' table directly here for accuracy:
        const { count } = await supabase
          .from("projects")
          .select("*", { count: "exact", head: true })
          .eq("user_id", userId);

        if ((count || 0) >= LIMITS.FREE.MAX_ACTIVE_PROJECTS) {
          res.status(403).json({
            error: `Max project limit reached (${LIMITS.FREE.MAX_ACTIVE_PROJECTS}). Delete one to create new.`,
          });
          return;
        }
      }

      // 4. Usage is OK -> Attach usage row to req for the next step to increment
      (req as any).usageRow = currentUsage;
      next();
    } catch (err) {
      console.error("Rate Limit Middleware Exception:", err);
      res.status(500).json({ error: "Server error checking limits" });
    }
  };
};

// Helper to increment counter AFTER success
export const incrementUsage = async (
  userId: string,
  type: "chat" | "pr" | "project_create",
) => {
  //   if (ADMIN_USER_IDS.includes(userId)) return;
  const column =
    type === "chat"
      ? "chat_count"
      : type === "pr"
        ? "pr_count"
        : "project_create_count";

  // We use a raw RPC or just a simple increment query
  // Supabase doesn't have a simple "increment" atomic operator via JS client easily without RPC,
  // but fetching and updating is "okay" for low volume.
  // For strict atomicity, use this RPC:

  await supabase.rpc("increment_usage", {
    user_id_param: userId,
    column_name: column,
  });
};
