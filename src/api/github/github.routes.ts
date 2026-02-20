import { Router } from "express";
import { createPullRequest } from "./github.controller";
import { requireAuth } from "../../middlewares/auth.middleware";
import { checkRateLimit } from "../../middlewares/rateLimit.middleware";

const router = Router();

// POST /api/github/pr
// Protected route: Only logged-in users can create PRs
router.post("/pr", requireAuth, checkRateLimit("pr"), createPullRequest);

export default router;
