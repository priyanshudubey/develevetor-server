import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import { chatWithProject, getChatHistory } from "./chat.controller";
import { checkRateLimit } from "../../middlewares/rateLimit.middleware";

const router = Router();
router.use(requireAuth);
router.get("/:projectId", getChatHistory);
router.post("/", checkRateLimit("chat"), chatWithProject);

export default router;
