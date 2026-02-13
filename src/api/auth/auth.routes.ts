import { Router } from "express";
import { login, callback, getMe, logout } from "./auth.controller";

const router = Router();

router.get("/github", login);
router.get("/github/callback", callback);
router.get("/me", getMe);
router.post("/logout", logout);

export default router;
