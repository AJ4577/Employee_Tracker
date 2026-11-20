// POST /functions/v1/invite-user  { email, display_name, role: "admin"|"staff", phone?, coverage_area? }
// Admin only. Creates an invite-only account (no public signup), a pending profile and an
// invitation that expires after INVITE_TTL_HOURS (default 72). The invite email comes from Supabase Auth.
import { getCaller, HttpError, rateLimit, readJson, serve, serviceClient } from "../_shared/http.ts";

interface Body {
  email?: string;
  display_name?: string;
  role?: string;
  phone?: string | null;
  coverage_area?: string | null;
  resend?: boolean;
}

serve(async (req) => {
  const { caller } = await getCaller(req);
  if (!caller.is_admin) throw new HttpError(403, "forbidden");
  const body = await readJson<Body>(req);
  const email = (body.email ?? "").trim().toLowerCase();
  const name = (body.display_name ?? "").trim();
  const role = body.role === "admin" ? "admin" : body.role === "staff" ? "staff" : null;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) throw new HttpError(400, "validation", "Invalid email");
  if (!name || name.length > 120) throw new HttpError(400, "validation", "Name is required");
  if (!role) throw new HttpError(400, "validation", "Role must be admin or staff");
  if (role === "admin" && caller.role !== "owner") throw new HttpError(403, "forbidden", "Only the owner can invite admins");

  const svc = serviceClient();
  await rateLimit(svc, `invite:${caller.id}`, 30, 3600);

  const appUrl = Deno.env.get("APP_URL");
  if (!appUrl) throw new HttpError(500, "server_misconfigured", "APP_URL not set");
  const ttlHours = Number(Deno.env.get("INVITE_TTL_HOURS") ?? "72");

  const { data: existing } = await svc.from("profiles").select("id, organization_id, status").ilike("email", email).maybeSingle();
  if (existing && !(body.resend && existing.status === "invited" && existing.organization_id === caller.organization_id)) {
    throw new HttpError(409, "already_exists", "An account with this email already exists");
  }

  const { data: invited, error: invErr } = await svc.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${appUrl.replace(/\/$/, "")}/accept-invite`,
    data: { display_name: name },
  });
  if (invErr || !invited.user) throw new HttpError(502, "invite_failed", invErr?.message ?? "Invite failed");
  const uid = invited.user.id;

  if (!existing) {
    const { error: pErr } = await svc.from("profiles").insert({
      id: uid,
      organization_id: caller.organization_id,
      role,
      status: "invited",
      display_name: name,
      email,
      phone: body.phone?.trim() || null,
      coverage_area: body.coverage_area?.trim() || null,
      created_by: caller.id,
    });
    if (pErr) throw new HttpError(500, "profile_create_failed", pErr.message);
  }
  await svc.from("invitations").update({ status: "revoked" }).eq("auth_user_id", uid).eq("status", "pending");
  const { error: iErr } = await svc.from("invitations").insert({
    organization_id: caller.organization_id,
    email,
    role,
    auth_user_id: uid,
    invited_by: caller.id,
    expires_at: new Date(Date.now() + ttlHours * 3600e3).toISOString(),
  });
  if (iErr) throw new HttpError(500, "invitation_create_failed", iErr.message);
  return { user_id: uid, email, role, expires_in_hours: ttlHours };
});
