import { Request, Response } from "express";
import { resend } from "../../config/resend";
import { logger } from "../../config/logger";

export const handleNewUserWebhook = async (req: Request, res: Response): Promise<any> => {
  try {
    // 1. Security Check: Validate Webhook Secret
    const webhookSecret = req.headers["x-supabase-webhook-secret"];
    if (webhookSecret !== process.env.SUPABASE_WEBHOOK_SECRET) {
      logger.warn("Unauthorized webhook attempt");
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 2. Extract Data from Payload
    const record = req.body?.record;
    if (!record) {
      return res.status(400).json({ error: "Invalid payload: missing record" });
    }

    const email = record.email;
    const metadata = record.raw_user_meta_data || {};
    const name = metadata.full_name || metadata.user_name || "Developer";

    if (!email) {
      return res.status(400).json({ error: "Invalid payload: missing email" });
    }

    logger.info(`Sending welcome email to ${email}`);

    // 3. Send Email via Resend
    const { data, error } = await resend.emails.send({
      from: "DevElevator <onboarding@develevator.com>", // Make sure to verify this domain in Resend
      to: [email],
      subject: "Welcome to DevElevator! Let's map your architecture.",
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #18181b;">
          <h1 style="color: #10b981;">Welcome to DevElevator, ${name}! 🚀</h1>
          <p>We're thrilled to have you on board.</p>
          <p>
            DevElevator is your AI Staff Engineer. You can now connect your GitHub account
            to <strong>instantly audit your code</strong>, find hidden vulnerabilities, and 
            <strong>generate gorgeous architecture maps</strong> with zero configuration.
          </p>
          
          <div style="background-color: #f4f4f5; padding: 20px; border-radius: 8px; margin: 24px 0;">
            <h3 style="margin-top: 0;">Next Steps:</h3>
            <ol style="margin-bottom: 0;">
              <li>Connect your GitHub repository in the dashboard.</li>
              <li>Wait for the AST parsing pipeline to map your codebase.</li>
              <li>Start chatting with your codebase and generating wikis!</li>
            </ol>
          </div>
          
          <a href="${process.env.CLIENT_URL}/dashboard" style="display: inline-block; background-color: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
            Go to Dashboard
          </a>
          
          <p style="margin-top: 32px; font-size: 12px; color: #71717a;">
            - The DevElevator Team<br/>
            <em>Built for developers, by developers.</em>
          </p>
        </div>
      `,
    });

    if (error) {
      logger.error("Error sending welcome email:", error);
      return res.status(500).json({ error: "Failed to send email" });
    }

    return res.status(200).json({ message: "Welcome email sent successfully", data });
  } catch (err: any) {
    logger.error("Webhook error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};
