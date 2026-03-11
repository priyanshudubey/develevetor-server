import { Router } from "express";
import { handleNewUserWebhook } from "./webhooks.controller";

const router = Router();

// Endpoint for Supabase to hit when a new auth.users record is created
router.post("/supabase/new-user", handleNewUserWebhook);

export default router;
