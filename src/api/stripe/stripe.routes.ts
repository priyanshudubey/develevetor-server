import { Router } from "express";
import {
  createCheckoutSession,
  createPortalSession,
} from "./stripe.controller";
import { requireAuth } from "../../middlewares/auth.middleware";

const router = Router();

router.post("/create-checkout-session", requireAuth, createCheckoutSession);
router.post("/create-portal-session", requireAuth, createPortalSession);

export default router;
