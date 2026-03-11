import { Request, Response } from "express";
import Stripe from "stripe";
import { logger } from "../../config/logger";
import { supabase } from "../../config/supabase";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2026-01-28.clover",
});

export const createCheckoutSession = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const userId = (req as any).user?.id;
  const { priceId } = req.body;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      // This is CRITICAL: We pass the Supabase user ID here so the webhook knows who to upgrade
      client_reference_id: userId,

      // Where Stripe sends them after payment
      success_url: `${process.env.CLIENT_URL}/dashboard/settings?session_id={CHECKOUT_SESSION_ID}&success=true`,
      cancel_url: `${process.env.CLIENT_URL}/dashboard/settings?canceled=true`,
    });

    res.json({ url: session.url });
  } catch (error: any) {
    // console.error("❌ RAW STRIPE ERROR:", error.message);
    logger.error("Stripe Checkout Error:", error.message);
    res.status(500).json({ error: "We couldn't initiate the Stripe checkout. Please try again later." });
  }
};

export const handleStripeWebhook = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const sig = req.headers["stripe-signature"] as string;
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET as string;

  let event: Stripe.Event;
  // console.log("🔔 Received Stripe Webhook:", req.body);

  try {
    // 1. Verify the signature using the raw body
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err: any) {
    logger.error(`Webhook Error: ${err.message}`);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  // 2. Handle the specific event we care about
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;

    // Remember when we passed the userId into client_reference_id? Here it is!
    const userId = session.client_reference_id;

    // console.log("==================================================");
    // console.log("🔥 WEBHOOK CAUGHT A CHECKOUT SESSION! 🔥");
    // console.log("➡️ Stripe Customer ID:", session.customer);
    // console.log("➡️ Stripe Subscription ID:", session.subscription);
    // console.log("➡️ Supabase User ID (client_reference_id):", userId);
    // console.log("==================================================");

    // if (!userId) {
    //   console.log(
    //     "❌ WARNING: No Supabase User ID found! Database update skipped.",
    //   );
    // }

    if (userId) {
      try {
        // 3. Upgrade the user in Supabase
        // (Adjust table names based on your exact schema)

        // Update user tier
        await supabase
          .from("users")
          .update({
            plan: "PRO",
            stripe_customer_id: session.customer as string,
            stripe_subscription_id: session.subscription as string,
          })
          .eq("id", userId);

        // Reset/Increase their usage limits
        await supabase
          .from("user_usage")
          .update({
            chat_count: 0,
            pr_count: 0,
            project_count: 0,
            // You might have max_projects here too
          })
          .eq("user_id", userId);

        logger.info(`✅ Successfully upgraded user ${userId} to PRO`);
      } catch (dbError) {
        logger.error("Database upgrade failed:", dbError);
      }
    }
  }

  // 4. Always return a 200 so Stripe knows we received it
  res.status(200).json({ received: true });
};

export const createPortalSession = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const userId = (req as any).user?.id;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    // 1. Get the user's Stripe Customer ID from Supabase
    const { data: user, error } = await supabase
      .from("users")
      .select("stripe_customer_id")
      .eq("id", userId)
      .single();

    if (error || !user?.stripe_customer_id) {
      res
        .status(404)
        .json({ error: "Customer not found. Have you upgraded yet?" });
      return;
    }

    // 2. Ask Stripe for a secure portal login link
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${process.env.CLIENT_URL}/dashboard/settings`,
    });

    res.json({ url: portalSession.url });
  } catch (error: any) {
    logger.error("Stripe Portal Error:", error.message);
    res.status(500).json({ error: "We couldn't open the billing portal. Please try again later." });
  }
};
