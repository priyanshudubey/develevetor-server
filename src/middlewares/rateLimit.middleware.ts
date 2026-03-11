/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║    DevElevator  ·  Rate Limit Middleware  ·  Weighted Costing   ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import { Request, Response, NextFunction } from "express";
import { supabase } from "../config/supabase";
import { logger } from "../config/logger";
import { MODEL_CONFIGS, DEFAULT_MODEL } from "../services/ai.service";
import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";

// ─── Redis Setup ─────────────────────────────────────────────────────────────

const redisUrl = process.env.UPSTASH_REDIS_REST_URL || "";
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || "";

let redis: Redis | undefined;
try {
  if (redisUrl && redisToken) {
    redis = new Redis({
      url: redisUrl,
      token: redisToken,
    });
  } else {
    logger.warn("Upstash Redis credentials missing! Rate limits will gracefully bypass caching.");
  }
} catch (err) {
  logger.error("Failed to initialize Redis:", err);
}

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
    // RPM Limits for Spam Protection
    RPM: 20,
  },
  PRO: {
    CHAT_BUDGET_PER_DAY: 9_999,
    PRS_PER_DAY: 999,
    PROJECT_CREATES_PER_DAY: 10,
    MAX_ACTIVE_PROJECTS: 15,
    MAX_MODEL_COST: 99,           // No model restrictions for PRO
    RPM: 100,
  },
} as const;

const ADMIN_USER_IDS: (string | undefined)[] = [process.env.ADMIN_USER_ID];

type LimitType = "chat" | "pr" | "project_create";

// ─── Utility ──────────────────────────────────────────────────────────────────

function getModelCost(modelId: string): number {
  return MODEL_CONFIGS[modelId]?.cost ?? MODEL_CONFIGS[DEFAULT_MODEL]?.cost ?? 1;
}

// ─── Tier 1: Spam Protection (Sliding Window) ─────────────────────────────────

const rateLimitFree = redis
  ? new Ratelimit({
      redis: redis,
      limiter: Ratelimit.slidingWindow(LIMITS.FREE.RPM, "1 m"),
      analytics: true,
      prefix: "@upstash/ratelimit:free",
    })
  : null;

const rateLimitPro = redis
  ? new Ratelimit({
      redis: redis,
      limiter: Ratelimit.slidingWindow(LIMITS.PRO.RPM, "1 m"),
      analytics: true,
      prefix: "@upstash/ratelimit:pro",
    })
  : null;

export const strictRateLimit = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const userId = (req as any).user?.id;
  const userPlan: "FREE" | "PRO" =
    (req as any).user?.plan === "PRO" ? "PRO" : "FREE";
  
  // Skip if no redis or no user info (though auth should guarantee user)
  if (!redis || !userId) {
    next();
    return;
  }

  // Admins bypass
  if (ADMIN_USER_IDS.includes(userId)) {
    next();
    return;
  }

  try {
    const limiter = userPlan === "PRO" ? rateLimitPro : rateLimitFree;
    const currentLimits = LIMITS[userPlan];
    
    if (limiter) {
      const { success, reset } = await limiter.limit(`spam_protect:${userId}`);
      if (!success) {
        res.status(429).json({
          error: "Too Many Requests",
          message: `You have exceeded the exact rate limit of ${currentLimits.RPM} requests per minute.`,
          resetAt: new Date(reset).toISOString(),
        });
        return;
      }
    }
    next();
  } catch (err) {
    logger.error("strictRateLimit Exception:", err);
    // Fail open if Redis fails so we don't block users accidentally
    next();
  }
};


// ─── Concurrency Mutex Lock Helpers ──────────────────────────────────────────

export const releaseProjectCreateLock = async (userId: string) => {
  if (!redis) return;
  try {
    await redis.del(`lock:project_create:${userId}`);
  } catch (err) {
    logger.error("Failed to release lock:", err);
  }
};


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
      // ── Tier 3: Concurrency Mutex Locks ────────────────────────────────
      if (type === "project_create" && redis) {
        const lockKey = `lock:project_create:${userId}`;
        // NX: Set only if it does not exist. EX: Expire in 30 seconds.
        const lockAcquired = await redis.set(lockKey, 1, { nx: true, ex: 30 });
        if (!lockAcquired) {
            logger.warn(`Project create lock prevented double-click for ${userId}`);
            res.status(409).json({ error: "Workspace creation already in progress. Please wait." });
            return;
        }
      }


      // ── Tier 2: Atomic Quota Management ────────────────────────────────

      // 1. Calculate Cost needed for this request
      let requestCost = 1;
      let requestedModel = DEFAULT_MODEL;

      if (type === "chat") {
        requestedModel = req.body?.model ?? DEFAULT_MODEL;
        requestCost = getModelCost(requestedModel);
        const modelCost = requestCost;
        const modelCfg = MODEL_CONFIGS[requestedModel] ?? MODEL_CONFIGS[DEFAULT_MODEL]!;

        // FREE tier: block heavy models entirely
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
      }

      const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
      const dailyUsageKey = `daily_usage:${userId}:${today}:${type}`;
      let checkDbRequired = true;

      // 2. Try Redis Cache INCRBY
      if (redis) {
          // If the key exists, INCRBY will work and we don't need the DB.
          // If the key doesn't exist, INCRBY will create it starting at 0 + requestCost.
          // However, we need to know if we just created it so we can hydrate from Supabase 
          // to carry over previous usage for the day if Redis lost its cache.
          
          const keyExists = await redis.exists(dailyUsageKey);

          if (keyExists) {
             checkDbRequired = false;
             const currentUsedStr = await redis.get<string | null>(dailyUsageKey);
             const currentUsed = currentUsedStr ? parseInt(currentUsedStr, 10) : 0;
             
             // Check if we have budget
             const budgetCol = type === "chat" ? currentLimits.CHAT_BUDGET_PER_DAY : type === "pr" ? currentLimits.PRS_PER_DAY : currentLimits.PROJECT_CREATES_PER_DAY;
             
             if (currentUsed + requestCost > budgetCol) {
                // Reject immediately
                if (type === "project_create") await releaseProjectCreateLock(userId);

                if (type === "chat") {
                     res.status(429).json({
                        error: userPlan === "PRO"
                          ? `Fair use limit reached. Resets tomorrow.`
                          : `Daily chat budget exhausted (${currentLimits.CHAT_BUDGET_PER_DAY} credits/day). Upgrade to Pro for unlimited access!`,
                        creditsUsed: currentUsed,
                        creditsTotal: currentLimits.CHAT_BUDGET_PER_DAY,
                        modelCost: requestCost,
                     });
                     return;
                } else {
                     res.status(429).json({
                        error: userPlan === "PRO" ? `Fair use limit reached for today.` : `Daily limit reached for this action. Upgrade for more bandwidth.`,
                     });
                     return;
                }
             }
             
             // Deduct / Add Cost (simulate)
             // We do NOT call incrby here. We let the incrementUsage function handle the final incrby asynchronously later to ensure accurate DB sync. 
             // We just know they are under limit for now.
             
          }
      }

      let currentUsage: any = null;

      // 3. Hydrate from DB if Redis missed or Redis is offline
      if (checkDbRequired) {
          let { data: usageData, error } = await supabase
            .from("user_usage")
            .select("*")
            .eq("user_id", userId)
            .maybeSingle();

          if (error) {
            logger.error("Rate Limit: failed to fetch usage", { error: error.message, userId });
            if (type === "project_create") await releaseProjectCreateLock(userId);
            res.status(500).json({ error: "Could not verify usage limits" });
            return;
          }

          if (!usageData) {
            logger.info(`Rate Limit: self-healing — creating usage row for ${userId}`);
            const { data: newUsage, error: insertError } = await supabase
              .from("user_usage")
              .insert([{ user_id: userId }])
              .select()
              .single();

            if (insertError || !newUsage) {
              logger.error("Rate Limit: could not create usage row", insertError);
              if (type === "project_create") await releaseProjectCreateLock(userId);
              res.status(500).json({ error: "Could not initialize usage limits" });
              return;
            }
            usageData = newUsage;
          }

          currentUsage = usageData;

          // Checking if DB needs daily reset before reading its values
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

          // Now Hydrate Redis!
          if (redis) {
              await redis.set(`daily_usage:${userId}:${today}:chat`, currentUsage.chat_count || 0, { ex: 86400 });
              await redis.set(`daily_usage:${userId}:${today}:pr`, currentUsage.pr_count || 0, { ex: 86400 });
              await redis.set(`daily_usage:${userId}:${today}:project_create`, currentUsage.project_create_count || 0, { ex: 86400 });
          }

          // Evaluate limits against DB values directly 
          const dbValCol = type === "chat" ? currentUsage.chat_count : type === "pr" ? currentUsage.pr_count : currentUsage.project_create_count;
          const budgetCol = type === "chat" ? currentLimits.CHAT_BUDGET_PER_DAY : type === "pr" ? currentLimits.PRS_PER_DAY : currentLimits.PROJECT_CREATES_PER_DAY;

          if ((dbValCol || 0) + requestCost > budgetCol) {
                if (type === "project_create") {
                    await releaseProjectCreateLock(userId);
                }
                
                if (type === "chat") {
                     res.status(429).json({
                        error: userPlan === "PRO"
                          ? `Fair use limit reached. Resets tomorrow.`
                          : `Daily chat budget exhausted (${currentLimits.CHAT_BUDGET_PER_DAY} credits/day). Upgrade to Pro for unlimited access!`,
                        creditsUsed: currentUsage.chat_count,
                        creditsTotal: currentLimits.CHAT_BUDGET_PER_DAY,
                        modelCost: requestCost,
                     });
                     return;
                } else {
                     res.status(429).json({
                        error: userPlan === "PRO" ? `Fair use limit reached for today.` : `Daily limit reached for this action. Upgrade for more bandwidth.`,
                     });
                     return;
                }
          }
      }
      
      // Secondary logic for project_create (Max Active Projects) - still requires DB ping for accuracy if needed
      if (type === "project_create") {
            const { count } = await supabase
              .from("projects")
              .select("*", { count: "exact", head: true })
              .eq("user_id", userId)
              .neq("status", "ARCHIVED");

            if ((count ?? 0) >= currentLimits.MAX_ACTIVE_PROJECTS) {
              await releaseProjectCreateLock(userId);
              res.status(403).json({
                error: `Max workspace limit reached (${currentLimits.MAX_ACTIVE_PROJECTS} on ${userPlan} plan). Delete an existing workspace to create a new one.`,
              });
              return;
            }
      }

      // Attach cost so controller can pass it to incrementUsage if chat
      if (type === "chat") {
          (req as any).modelCost = requestCost;
      }
      
      // Support legacy systems attaching usage row
      if (currentUsage) {
          (req as any).usageRow = currentUsage;
      }

      next();

    } catch (err) {
      if (type === "project_create") await releaseProjectCreateLock(userId);
      logger.error("Rate Limit Middleware Exception:", err);
      res.status(500).json({ error: "Server error checking limits" });
    }
  };
};

// ─── incrementUsage ───────────────────────────────────────────────────────────

/**
 * Atomically increments the usage counter by `amount` (model cost).
 * 
 * [ASYNC / FIRE-AND-FORGET]: This fires a supabase RPC to update the persistent daily
 * counter (chat_count) and lifetime total (total_chats) without forcing the client 
 * to await for the Postgres transaction to finish.
 * It also increments the high-speed Redis atomic counter.
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

  // 1. Atomic quick Redis INCRBY
  if (redis) {
      const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
      const dailyUsageKey = `daily_usage:${userId}:${today}:${type}`;
      redis.incrby(dailyUsageKey, amount).catch(err => logger.error("Redis INCRBY async error:", err));
  }
  
  // 2. Fire and forget to Supabase Postgres (historical accuracy + backup state)
  const syncToDb = async () => {
    try {
      const { error } = await supabase.rpc("increment_usage", {
        user_id_param: userId,
        column_name: column,
        amount,
      });
      if (error) {
        logger.error("Async incrementUsage Supabase RPC Error:", error);
      }
    } catch (err) {
      logger.error("Async incrementUsage Execution Error:", err);
    }
  };
  
  syncToDb();
};

