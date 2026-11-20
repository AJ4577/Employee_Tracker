// POST /functions/v1/send-welcome  {}  (signed-in user, right after registering)
// Sends a one-time "thank you for registering" email to the caller from the app's own sender
// (Gmail SMTP over SSL, port 465 — Supabase Edge Functions block port 587).
// Secrets: SMTP_HOST (default smtp.gmail.com), SMTP_PORT (default 465), SMTP_USER, SMTP_PASS (Gmail app password),
//          SMTP_FROM_NAME (default KisanRoute), APP_URL.
import nodemailer from "npm:nodemailer@10.6.0";
import { HttpError, serve, serviceClient, userClient } from "../_shared/http.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

serve(async (req) => {
  const { data: u, error: uErr } = await userClient(req).auth.getUser();
  if (uErr || !u.user) throw new HttpError(401, "unauthenticated");

  const user = Deno.env.get("SMTP_USER");
  const pass = Deno.env.get("SMTP_PASS");
  if (!user || !pass) throw new HttpError(503, "provider_not_configured", "Email sending is not configured");

  const svc = serviceClient();
  const { data: rows, error } = await svc.rpc("claim_welcome_email", { p_user: u.user.id });
  if (error) throw new HttpError(500, "claim_failed");
  const p = rows?.[0];
  if (!p) return { sent: false, reason: "already_sent_or_not_registered" };

  const appUrl = (Deno.env.get("APP_URL") ?? "").replace(/\/$/, "");
  const fromName = Deno.env.get("SMTP_FROM_NAME") ?? "KisanRoute";
  const name = esc(p.display_name);
  const pending = p.status === "pending";
  const subject = pending ? "Thank you for registering with KisanRoute" : "Welcome to KisanRoute";
  const body = pending
    ? `Your ${p.role === "admin" ? "admin" : "staff"} registration has been received. An ${p.role === "admin" ? "owner" : "administrator"} will review it, and you can sign in as soon as it is approved.`
    : "Your account is active. You can sign in any time with a one-time code sent to your email.";

  const transport = nodemailer.createTransport({
    host: Deno.env.get("SMTP_HOST") ?? "smtp.gmail.com",
    port: Number(Deno.env.get("SMTP_PORT") ?? "465"),
    secure: true,
    auth: { user, pass },
  });
  try {
    await transport.sendMail({
      from: { name: fromName, address: user },
      to: p.email,
      subject,
      text: `Hi ${p.display_name},\n\nThank you for registering with KisanRoute.\n${body}\n\n${appUrl ? `Sign in: ${appUrl}/login\n\n` : ""}— KisanRoute`,
      html: `<div style="font-family:Arial,sans-serif;max-width:520px">
  <h2 style="color:#1f6f3a">Thank you for registering, ${name}!</h2>
  <p>${esc(body)}</p>
  ${appUrl ? `<p><a href="${esc(appUrl)}/login" style="background:#1f6f3a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Open KisanRoute</a></p>` : ""}
  <p style="color:#5b6b61;font-size:13px">If you didn't register, you can ignore this email.</p>
</div>`,
    });
  } catch (e) {
    await svc.rpc("release_welcome_email", { p_user: u.user.id });
    console.error(JSON.stringify({ error: "smtp_failed", message: (e as Error).message }));
    throw new HttpError(502, "email_failed", "Could not send the email");
  }
  return { sent: true };
});
