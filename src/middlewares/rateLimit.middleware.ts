/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║    DevElevator  ·  Rate Limit Middleware  ·  Weighted Costing   ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import { Request, Response, NextFunction } from "express";
import { supabase } from "../config/supabase";
import { logger } from "../config/logger";
import { MODEL_CONFIGS, DEFAULT_MODEL } from "../services/ai.service";

// ─── Tier Definitions ─────────────────────────────────────────────────────────

const LIMITS = {
  FREE: {
    /** Weighted daily chat budget (each model deducts its cost) */
    CHAT_BUDGET_PER_DAY: 15,
    PRS_PER_DAY: 3,
    PROJECT_CREATES_PER_DAY: 2,
    MAX_ACTIVE_PROJECTS: 3,
    /** FREE tier cannot use models with cost > this threshold */
    MAX_MODEL_COST: 1,
  },
  PRO: {
    CHAT_BUDGET_PER_DAY: 9_999,
    PRS_PER_DAY: 999,
    PROJECT_CREATES_PER_DAY: 10,
    MAX_ACTIVE_PROJECTS: 15,
    MAX_MODEL_COST: 99,           // No model restrictions for PRO
  },
} as const;

const ADMIN_USER_IDS: (string | undefined)[] = [process.env.ADMIN_USER_ID];

type LimitType = "chat" | "pr" | "project_create";

// ─── Utility ──────────────────────────────────────────────────────────────────

function getModelCost(modelId: string): number {
  return MODEL_CONFIGS[modelId]?.cost ?? MODEL_CONFIGS[DEFAULT_MODEL]?.cost ?? 1;
}

// ─── checkRateLimit Middleware ────────────────────────────────────────────────

export const checkRateLimit = (type: LimitType) => {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const userId = (req as any).user?.id;
    const userPlan: "FREE" | "PRO" =
      (req as any).user?.plan === "PRO" ? "PRO" : "FREE";
    const currentLimits = LIMITS[userPlan];

    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // Admins bypass all limits
    if (ADMIN_USER_IDS.includes(userId)) {
      next();
      return;
    }

    try {
      // ── 1. Fetch or self-heal usage row ────────────────────────────────────
      let { data: currentUsage, error } = await supabase
        .from("user_usage")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) {
        logger.error("Rate Limit: failed to fetch usage", { error: error.message, userId });
        res.status(500).json({ error: "Could not verify usage limits" });
        return;
      }

      if (!currentUsage) {
        logger.info(`Rate Limit: self-healing — creating usage row for ${userId}`);
        const { data: newUsage, error: insertError } = await supabase
          .from("user_usage")
          .insert([{ user_id: userId }])
          .select()
          .single();

        if (insertError || !newUsage) {
          logger.error("Rate Limit: could not create usage row", insertError);
          res.status(500).json({ error: "Could not initialize usage limits" });
          return;
        }
        currentUsage = newUsage;
      }

      // ── 2. Daily reset if > 24 h since last_reset_at ───────────────────────
      const now = new Date();
      const lastReset = new Date(currentUsage.last_reset_at);
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

        if (!resetError && resetData) currentUsage = resetData;
      }

      const nextResetTime = new Date(
        new Date(currentUsage.last_reset_at).getTime() + oneDay,
      );

      // ── 3. Evaluate limits ─────────────────────────────────────────────────

      if (type === "chat") {
        // ── a. Weighted model cost ──────────────────────────────────────────
        const requestedModel: string = req.body?.model ?? DEFAULT_MODEL;
        const modelCost = getModelCost(requestedModel);
        const modelCfg = MODEL_CONFIGS[requestedModel] ?? MODEL_CONFIGS[DEFAULT_MODEL]!;

        // ── b. FREE tier: block heavy models entirely ───────────────────────
        if (userPlan === "FREE" && modelCost > currentLimits.MAX_MODEL_COST) {
          logger.warn(`Rate Limit: FREE user blocked from heavy model`, {
            userId, model: requestedModel, cost: modelCost,
          });
          res.status(403).json({
            error: `"${modelCfg.label}" requires a Pro subscription (model cost: ${modelCost}x). Upgrade to unlock all models.`,
            upgradeRequired: true,
          });
          return;
        }

        // ── c. Budget check: current + cost must be ≤ daily budget ─────────
        const remainingBudget =
          currentLimits.CHAT_BUDGET_PER_DAY - (currentUsage.chat_count ?? 0);

        if (modelCost > remainingBudget) {
          logger.warn(`Rate Limit: chat budget exhausted`, {
            userId, userPlan, used: currentUsage.chat_count,
            budget: currentLimits.CHAT_BUDGET_PER_DAY, modelCost,
          });
          res.status(429).json({
            error:
              userPlan === "PRO"
                ? `Fair use limit reached. Resets at ${nextResetTime.toISOString()}.`
                : `Daily chat budget exhausted (${currentLimits.CHAT_BUDGET_PER_DAY} credits/day). "${modelCfg.label}" costs ${modelCost} credits. Upgrade to Pro for unlimited access!`,
            resetAt: nextResetTime.toISOString(),
            creditsUsed: currentUsage.chat_count,
            creditsTotal: currentLimits.CHAT_BUDGET_PER_DAY,
            modelCost,
          });
          return;
        }

        // ── d. Attach cost so controller can pass it to incrementUsage ──────
        (req as any).modelCost = modelCost;

      } else if (type === "pr") {
        if ((currentUsage.pr_count ?? 0) >= currentLimits.PRS_PER_DAY) {
          res.status(429).json({
            error:
              userPlan === "PRO"
                ? "Fair use PR limit reached for today."
                : `Daily PR limit reached (${currentLimits.PRS_PER_DAY}/day). Upgrade to Pro for unmetered PRs!`,
            resetAt: nextResetTime.toISOString(),
          });
          return;
        }

      } else if (type === "project_create") {
        if (
          (currentUsage.project_create_count ?? 0) >=
          currentLimits.PROJECT_CREATES_PER_DAY
        ) {
          res.status(429).json({
            error: `You can only create ${currentLimits.PROJECT_CREATES_PER_DAY} workspaces per day on the ${userPlan} plan.`,
            resetAt: nextResetTime.toISOString(),
          });
          return;
        }

        // Total active projects check
        const { count } = await supabase
          .from("projects")
          .select("*", { count: "exact", head: true })
          .eq("user_id", userId)
          .neq("status", "ARCHIVED");

        if ((count ?? 0) >= currentLimits.MAX_ACTIVE_PROJECTS) {
          res.status(403).json({
            error: `Max workspace limit reached (${currentLimits.MAX_ACTIVE_PROJECTS} on ${userPlan} plan). Delete an existing workspace to create a new one.`,
          });
          return;
        }
      }

      // ── 4. Passed — attach usage row and proceed ───────────────────────────
      (req as any).usageRow = currentUsage;
      next();

    } catch (err) {
      logger.error("Rate Limit Middleware Exception:", err);
      res.status(500).json({ error: "Server error checking limits" });
    }
  };
};

// ─── incrementUsage ───────────────────────────────────────────────────────────

/**
 * Atomically increments the usage counter by `amount` (model cost).
 * Both the daily counter (chat_count) and the lifetime total (total_chats)
 * are updated in a single Supabase RPC transaction.
 *
 * @param userId  The user's ID
 * @param type    "chat" | "pr" | "project_create"
 * @param amount  Cost units to deduct (defaults to 1)
 */
export const incrementUsage = async (
  userId: string,
  type: "chat" | "pr" | "project_create",
  amount = 1,
) => {
  const column =
    type === "chat"
      ? "chat_count"
      : type === "pr"
        ? "pr_count"
        : "project_create_count";

  await supabase.rpc("increment_usage", {
    user_id_param: userId,
    column_name: column,
    amount,
  });
};
