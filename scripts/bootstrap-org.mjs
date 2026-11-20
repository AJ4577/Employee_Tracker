#!/usr/bin/env node
// One-time production/staging bootstrap: creates the organization and invites its OWNER.
// Run from a trusted machine. Reads secrets from the environment — never commit them.
//
//   SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=... APP_URL=https://app.example.com \
//   node scripts/bootstrap-org.mjs --org "Greenfield Agro" --email owner@company.com --name "Owner Name" [--tz Asia/Kolkata]
import { createClient } from "@supabase/supabase-js";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const appUrl = process.env.APP_URL;
const org = arg("org");
const email = arg("email")?.trim().toLowerCase();
const name = arg("name") ?? "Owner";
const tz = arg("tz", "Asia/Kolkata");
if (!url || !key || !appUrl || !org || !email) {
  console.error("Missing input. Need env SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL and --org, --email.");
  process.exit(1);
}
const svc = createClient(url, key, { auth: { persistSession: false } });

const { data: existing } = await svc.from("profiles").select("id").ilike("email", email).maybeSingle();
if (existing) {
  console.error("A profile with this email already exists. Aborting.");
  process.exit(1);
}
const { data: o, error: oErr } = await svc.from("organizations").insert({ name: org, timezone: tz }).select().single();
if (oErr) throw oErr;
const { data: inv, error: iErr } = await svc.auth.admin.inviteUserByEmail(email, {
  redirectTo: `${appUrl.replace(/\/$/, "")}/accept-invite`,
  data: { display_name: name },
});
if (iErr) {
  await svc.from("organizations").delete().eq("id", o.id);
  throw iErr;
}
const uid = inv.user.id;
const { error: pErr } = await svc.from("profiles").insert({ id: uid, organization_id: o.id, role: "owner", status: "invited", display_name: name, email });
if (pErr) throw pErr;
const { error: invErr } = await svc
  .from("invitations")
  .insert({ organization_id: o.id, email, role: "owner", auth_user_id: uid, expires_at: new Date(Date.now() + 72 * 3600e3).toISOString() });
if (invErr) throw invErr;
console.log(`Organization "${org}" created (${o.id}). Invitation emailed to ${email}; the link is valid for 72 hours.`);
