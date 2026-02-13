import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import { chatWithProject, getChatHistory } from "./chat.controller";

const router = Router();
router.use(requireAuth);
router.get("/:projectId", getChatHistory);
router.post("/", chatWithProject);

export default router;
