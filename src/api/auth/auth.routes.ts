import { Router } from "express";
import {
  login,
  callback,
  getMe,
  logout,
  getUserUsage,
} from "./auth.controller";
import { requireAuth } from "../../middlewares/auth.middleware";

const router = Router();

router.get("/github", login);
router.get("/github/callback", callback);
router.get("/me", getMe);
router.post("/logout", logout);
router.get("/usage", requireAuth, getUserUsage);

export default router;
