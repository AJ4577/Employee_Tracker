// Shared HTTP helpers for KisanRoute Edge Functions (Deno).
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";

const allowed = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const h: Record<string, string> = {
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-request-id",
    "access-control-allow-methods": "POST, OPTIONS",
    vary: "origin",
  };
  // Native apps send no Origin header; browsers must match the allow-list.
  if (origin && allowed.includes(origin)) h["access-control-allow-origin"] = origin;
  return h;
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

export function json(req: Request, status: number, body: unknown, requestId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "content-type": "application/json", "x-request-id": requestId, "cache-control": "no-store" },
  });
}

export function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new HttpError(500, "server_misconfigured");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Client that acts as the calling user (RLS + RPC role checks apply). */
export function userClient(req: Request): SupabaseClient {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) throw new HttpError(401, "unauthenticated");
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface Caller {
  id: string;
  organization_id: string;
  role: "owner" | "admin" | "staff";
  is_admin: boolean;
}

export async function getCaller(req: Request): Promise<{ caller: Caller; client: SupabaseClient }> {
  const client = userClient(req);
  const { data, error } = await client.rpc("me");
  if (error || !data?.profile) throw new HttpError(401, "unauthenticated");
  if (data.profile.status !== "active") throw new HttpError(403, "forbidden");
  return {
    client,
    caller: { id: data.profile.id, organization_id: data.profile.organization_id, role: data.profile.role, is_admin: data.is_admin },
  };
}

export async function rateLimit(svc: SupabaseClient, key: string, limit: number, windowS: number) {
  const { data, error } = await svc.rpc("hit_rate_limit", { p_key: key, p_limit: limit, p_window_s: windowS });
  if (error) throw new HttpError(500, "rate_limit_unavailable");
  if (data === false) throw new HttpError(429, "rate_limited");
}

export function serve(handler: (req: Request, requestId: string) => Promise<unknown>) {
  Deno.serve(async (req) => {
    const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
    if (req.method !== "POST") return json(req, 405, { error: { code: "method_not_allowed", message: "POST only", request_id: requestId } }, requestId);
    const len = Number(req.headers.get("content-length") ?? "0");
    if (len > 64 * 1024) return json(req, 413, { error: { code: "payload_too_large", message: "Request too large", request_id: requestId } }, requestId);
    try {
      const data = await handler(req, requestId);
      return json(req, 200, { data, request_id: requestId }, requestId);
    } catch (e) {
      if (e instanceof HttpError) {
        return json(req, e.status, { error: { code: e.code, message: e.message, request_id: requestId } }, requestId);
      }
      // Log without request bodies (may contain personal data).
      console.error(JSON.stringify({ request_id: requestId, error: (e as Error).message }));
      return json(req, 500, { error: { code: "internal", message: "Unexpected error", request_id: requestId } }, requestId);
    }
  });
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}
