// POST /functions/v1/admin-staff  { staff_id, action: "suspend" | "activate", reason? }
// Admin only. Updates the profile through the caller's own RPC (role/org checks in SQL), then
// bans/unbans the auth user with the service role so refresh tokens stop working.
// Already-issued access tokens are rejected for data immediately because every RLS policy and
// RPC requires profiles.status = 'active'.
import { getCaller, HttpError, readJson, serve, serviceClient } from "../_shared/http.ts";

serve(async (req) => {
  const { caller, client } = await getCaller(req);
  if (!caller.is_admin) throw new HttpError(403, "forbidden");
  const body = await readJson<{ staff_id?: string; action?: string; reason?: string }>(req);
  if (!body.staff_id || !/^[0-9a-f-]{36}$/i.test(body.staff_id)) throw new HttpError(400, "validation", "staff_id required");
  const status = body.action === "suspend" ? "suspended" : body.action === "activate" ? "active" : null;
  if (!status) throw new HttpError(400, "validation", "action must be suspend or activate");

  const { data, error } = await client.rpc("admin_set_staff_status", { p_staff: body.staff_id, p_status: status, p_reason: body.reason ?? null });
  if (error) throw new HttpError(error.message === "not_found" ? 404 : 403, error.message);

  const svc = serviceClient();
  const { error: banErr } = await svc.auth.admin.updateUserById(body.staff_id, { ban_duration: status === "suspended" ? "876000h" : "none" });
  if (banErr) throw new HttpError(502, "session_revoke_failed", "Profile updated but auth ban failed; retry");
  return { profile: data, sessions_revoked: status === "suspended" };
});
