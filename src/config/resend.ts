import { Resend } from "resend";

if (!process.env.RESEND_API_KEY) {
  console.warn("Missing RESEND_API_KEY environment variable. Emails will not be sent.");
}

export const resend = new Resend(process.env.RESEND_API_KEY || "re_dummy");
