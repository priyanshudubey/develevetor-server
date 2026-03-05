import { Router } from "express";
import { createOrder, verifyPayment, cancelSubscription } from "./razorpay.controller";
import { requireAuth } from "../../middlewares/auth.middleware";

const router = Router();
router.use(requireAuth);

router.post("/create-order", createOrder);
router.post("/verify-payment", verifyPayment);
router.post("/cancel-subscription", cancelSubscription);

export default router;
