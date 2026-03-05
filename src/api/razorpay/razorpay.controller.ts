import { Request, Response } from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import { logger } from "../../config/logger";
import { supabase } from "../../config/supabase";

// ─── Canonical Price Table (paise / cents) ────────────────────────────────────
// These are the ONLY accepted amounts. Any request with a different amount
// is rejected — preventing client-side price tampering.

const ALLOWED_PRICES: Record<string, number> = {
  INR: parseInt(process.env.RAZORPAY_PRO_AMOUNT_INR || "79900",  10), // ₹799
  USD: parseInt(process.env.RAZORPAY_PRO_AMOUNT_USD || "1500",   10), // $15
};

// ─── Lazy client (ensures env vars are loaded before use) ─────────────────────
let _razorpay: Razorpay | null = null;
function getRazorpay(): Razorpay {
  if (!_razorpay) {
    const key_id     = process.env.RAZORPAY_KEY_ID;
    const key_secret = process.env.RAZORPAY_KEY_SECRET;
    if (!key_id || !key_secret) {
      throw new Error("RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is not set in environment variables.");
    }
    _razorpay = new Razorpay({ key_id, key_secret });
  }
  return _razorpay;
}

// ─── Error helper (Razorpay SDK throws plain objects, not Error instances) ─────
function razorpayErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    // Razorpay SDK error shape: { error: { description, code, ... }, statusCode }
    const e = err as any;
    return e.error?.description ?? e.description ?? e.message ?? JSON.stringify(err);
  }
  return String(err);
}

// ─── Create Order ─────────────────────────────────────────────────────────────

export const createOrder = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const userId = (req as any).user?.id;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { currency, amount } = req.body as { currency?: string; amount?: number };

  // 1. Validate currency
  const resolvedCurrency = (currency || "USD").toUpperCase();
  if (!ALLOWED_PRICES[resolvedCurrency]) {
    res.status(400).json({ error: `Unsupported currency: ${resolvedCurrency}` });
    return;
  }

  // 2. Server-side price validation — the client cannot pass an arbitrary amount
  const canonicalAmount = ALLOWED_PRICES[resolvedCurrency];
  if (amount !== undefined && amount !== canonicalAmount) {
    logger.warn(`Price tamper attempt — user ${userId} sent ${amount} for ${resolvedCurrency}, expected ${canonicalAmount}`);
    res.status(400).json({ error: "Invalid amount for the selected currency." });
    return;
  }

  try {
    const rz    = getRazorpay();
    const order = await rz.orders.create({
      amount:   canonicalAmount,
      currency: resolvedCurrency,
      receipt:  `rcpt_${userId.slice(0, 8)}_${Date.now().toString().slice(-8)}`,
      notes:    { userId, currency: resolvedCurrency },
    });

    logger.info(`Razorpay order created: ${order.id} | ${resolvedCurrency} ${canonicalAmount} | user ${userId}`);

    res.json({
      orderId:  order.id,
      amount:   order.amount,
      currency: order.currency,
      keyId:    process.env.RAZORPAY_KEY_ID,
    });
  } catch (error: unknown) {
    const msg = razorpayErrorMessage(error);
    logger.error(`Razorpay createOrder error: ${msg}`, { raw: error });
    res.status(500).json({ error: `Payment order failed: ${msg}` });
  }
};

// ─── Verify Payment ───────────────────────────────────────────────────────────

export const verifyPayment = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const userId = (req as any).user?.id;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    res.status(400).json({ error: "Missing payment fields" });
    return;
  }

  try {
    // 1. Verify HMAC-SHA256 signature
    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET as string)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      logger.warn(`Razorpay signature mismatch for user ${userId}`);
      res.status(400).json({ error: "Invalid payment signature" });
      return;
    }

    // 2. Upgrade user plan in Supabase
    const { error: updateError } = await supabase
      .from("users")
      .update({ plan: "PRO", razorpay_payment_id, razorpay_order_id })
      .eq("id", userId);

    if (updateError) {
      logger.error("Supabase upgrade failed:", updateError.message);
      res.status(500).json({ error: "Failed to upgrade account" });
      return;
    }

    // 3. Reset daily usage counters on upgrade
    await supabase
      .from("user_usage")
      .update({ chat_count: 0, pr_count: 0, project_create_count: 0 })
      .eq("user_id", userId);

    logger.info(`✅ User ${userId} upgraded to PRO`);
    res.json({ success: true, message: "Account upgraded to Pro!" });
  } catch (error: unknown) {
    const msg = razorpayErrorMessage(error);
    logger.error(`verifyPayment error: ${msg}`, { raw: error });
    res.status(500).json({ error: "Payment verification failed" });
  }
};

// ─── Cancel Subscription ──────────────────────────────────────────────────────

export const cancelSubscription = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const userId = (req as any).user?.id;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    await supabase.from("users").update({ plan: "FREE" }).eq("id", userId);
    logger.info(`User ${userId} downgraded to FREE`);
    res.json({ success: true, message: "Subscription cancelled." });
  } catch (error: unknown) {
    const msg = razorpayErrorMessage(error);
    logger.error(`cancelSubscription error: ${msg}`, { raw: error });
    res.status(500).json({ error: "Failed to cancel subscription" });
  }
};
