import { Router } from "express";
import { createPullRequest } from "./github.controller";
import { requireAuth } from "../../middlewares/auth.middleware";

const router = Router();

// POST /api/github/pr
// Protected route: Only logged-in users can create PRs
router.post("/pr", requireAuth, createPullRequest);

export default router;
