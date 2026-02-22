import { Request, Response } from "express";
import { supabase } from "../../config/supabase";
import { logger } from "../../config/logger";

export const getDashboardData = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const userId = (req as any).user?.id;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    // 1. Fetch Recent Projects (Limit to 4)
    const { data: projects, error: projectsError } = await supabase
      .from("projects")
      .select("id, name, status, created_at, last_indexed_at")
      .eq("user_id", userId)
      .neq("status", "ARCHIVED")
      .order("created_at", { ascending: false })
      .limit(4);

    if (projectsError) throw projectsError;

    // 2. Fetch Lifetime/Current Usage Metrics
    // Assuming we pull the current user_usage row to get their total PRs and Chats
    const { data: usage } = await supabase
      .from("user_usage")
      .select("chat_count, pr_count")
      .eq("user_id", userId)
      .single();

    const totalChats = usage?.chat_count || 0;
    const totalPrs = usage?.pr_count || 0;

    // 🌟 SaaS Flex Metric: Calculate Estimated Time Saved
    // Let's estimate 10 mins saved per chat, and 45 mins saved per PR.
    const minutesSaved = totalChats * 10 + totalPrs * 45;
    const hoursSaved = (minutesSaved / 60).toFixed(1);

    const metrics = {
      interactions: totalChats,
      prsAutomated: totalPrs,
      timeSaved: `${hoursSaved} hrs`,
    };

    // 3. Construct the Activity Feed
    // For a production app, you might have an `activity_logs` table.
    // For now, we will map their recent projects into an activity timeline.
    const activityFeed = (projects || []).map((project, index) => ({
      id: project.id,
      type: index % 2 === 0 ? "chat" : "project", // Alternating icons for visual variety
      text:
        index === 0
          ? `Last active in workspace: ${project.name.split("/").pop()}`
          : `Synced repository: ${project.name}`,
      time: project.last_indexed_at || project.created_at,
    }));

    // 4. Send the unified payload
    res.json({
      metrics,
      recentProjects: projects || [],
      activityFeed,
    });
  } catch (error: any) {
    logger.error("Dashboard Fetch Error:", error);
    res.status(500).json({ error: "Failed to load dashboard data" });
  }
};
