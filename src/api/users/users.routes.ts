// src/api/users/users.routes.ts
import { Router } from "express";
import {
  getPreferences,
  updatePreferences,
  updateGithubToken,
  getIntegrationStatus,
  getUsageStats,
} from "./users.controller";
import { requireAuth } from "../../middlewares/auth.middleware";

const router = Router();

router.use(requireAuth);

// AI Preferences
router.get("/preferences", getPreferences);
router.patch("/preferences", updatePreferences);

// GitHub Vault
router.get("/integrations", getIntegrationStatus);
router.patch("/integrations/github", updateGithubToken);

router.get("/usage", getUsageStats);

export default router;
