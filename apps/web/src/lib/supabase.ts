import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const configError: string | null =
  !url || !anon
    ? "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Locally: copy apps/web/.env.example to apps/web/.env.local. On GitHub Pages: add them as repository Variables (Settings → Secrets and variables → Actions → Variables) and re-run the Pages workflow."
    : null;

// Session tokens are kept by supabase-js in localStorage (browser default). No passwords or
// privileged keys are stored. The anon key is public by design; all access is enforced by RLS.
// `||` (not `??`): CI passes unset repository variables as empty strings.
export const supabase: SupabaseClient = createClient(url || "http://invalid.local", anon || "invalid", {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  realtime: { params: { eventsPerSecond: 5 } },
});
