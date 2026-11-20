import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { DEFAULT_SETTINGS, type Me } from "@kisanroute/shared";
import { supabase } from "./supabase";
import { rpc, isNetworkError } from "./api";
import { clearLocalData, kvGet, kvSet } from "./db";
import { stopTracking } from "./tracking";
import { unregisterPush } from "./push";

interface Ctx {
  session: Session | null;
  ready: boolean;
  me: Me | null;
  meError: string | null;
  offline: boolean;
  settings: NonNullable<Me["settings"]>;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}
const SessionCtx = createContext<Ctx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const m = await rpc<Me>("me");
      setMe(m);
      setOffline(false);
      setMeError(null);
      await kvSet("me", JSON.stringify(m));
    } catch (e) {
      if (isNetworkError(e)) {
        setOffline(true);
        const cached = await kvGet("me");
        if (cached) setMe(JSON.parse(cached));
      } else setMeError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session) refresh();
    else setMe(null);
  }, [session, refresh]);

  const signOut = useCallback(async () => {
    try {
      await rpc("end_duty");
    } catch {
      /* may be offline or already ended */
    }
    await stopTracking();
    await unregisterPush();
    try {
      await rpc("log_session_event", { p_event: "logout", p_device: "staff-app" });
    } catch {
      /* best effort */
    }
    await clearLocalData();
    await supabase.auth.signOut();
  }, []);

  const settings = (me?.settings ?? { ...DEFAULT_SETTINGS, organization_name: "" }) as NonNullable<Me["settings"]>;
  return <SessionCtx.Provider value={{ session, ready, me, meError, offline, settings, refresh, signOut }}>{children}</SessionCtx.Provider>;
}

export function useSession(): Ctx {
  const v = useContext(SessionCtx);
  if (!v) throw new Error("useSession outside provider");
  return v;
}
