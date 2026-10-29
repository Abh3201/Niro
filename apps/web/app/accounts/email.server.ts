/**
 * Sign-in emails. Sent with Resend (https://resend.com) when
 * `RESEND_API_KEY` and `EMAIL_FROM` are set. Otherwise, outside production,
 * the link is printed to the server's log, so email sign-in works in
 * development without an account anywhere. `NIRO_EMAIL_OUTBOX` writes each
 * email as a line of JSON to that file instead: the browser tests read it.
 */
import { appendFile } from "node:fs/promises";

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Where emails go, or null when they can't be sent and email sign-in is off. */
function transport(): "resend" | "outbox" | "log" | null {
  if (process.env.NIRO_EMAIL_OUTBOX) return "outbox";
  if (process.env.RESEND_API_KEY && process.env.EMAIL_FROM) return "resend";
  if (process.env.NODE_ENV !== "production") return "log";
  return null;
}

export function emailEnabled(): boolean {
  return transport() !== null;
}

export async function sendEmail(email: Email): Promise<void> {
  switch (transport()) {
    case "outbox":
      await appendFile(
        process.env.NIRO_EMAIL_OUTBOX as string,
        `${JSON.stringify({ ...email, at: Date.now() })}\n`,
      );
      return;
    case "log":
      console.log(`[email to ${email.to}] ${email.subject}\n${email.text}`);
      return;
    case "resend": {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ from: process.env.EMAIL_FROM, ...email, to: [email.to] }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        // Resend explains in the body (an unverified domain, the daily limit).
        throw new Error(`Resend refused the email (${response.status}): ${await response.text()}`);
      }
      return;
    }
    default:
      throw new Error("Email isn't set up: set RESEND_API_KEY and EMAIL_FROM.");
  }
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The email with a sign-in link. */
export function signInEmail(to: string, url: string): Email {
  return {
    to,
    subject: "Sign in to Niro",
    text: `Open this link to sign in to Niro:\n\n${url}\n\nIt works once, for 10 minutes. If you didn't ask to sign in, ignore this email.`,
    html: `<p>Click to sign in to Niro:</p>
<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 18px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none">Sign in</a></p>
<p style="color:#666;font-size:13px">The link works once, for 10 minutes. If you didn't ask to sign in, ignore this email.</p>`,
  };
}
