import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_SETTINGS, isAdminRole, type Me } from "@kisanroute/shared";
import { supabase } from "./supabase";
import { rpc } from "./api";

interface AuthState {
  session: Session | null;
  loading: boolean;
  me: Me | null;
  meError: Error | null;
  /** Admin role but session is not aal2 while org requires MFA. */
  needsMfa: boolean;
  recovery: boolean;
  tz: string;
  settings: NonNullable<Me["settings"]>;
  refreshMe: () => Promise<unknown>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const qc = useQueryClient();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
      if (event === "SIGNED_OUT") qc.clear();
      if (event === "SIGNED_IN" || event === "MFA_CHALLENGE_VERIFIED" || event === "TOKEN_REFRESHED") {
        qc.invalidateQueries({ queryKey: ["me"] });
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [qc]);

  const meQ = useQuery({
    queryKey: ["me", session?.user.id],
    queryFn: () => rpc<Me>("me"),
    enabled: !!session,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
  });

  const value = useMemo<AuthState>(() => {
    const me = meQ.data ?? null;
    const settings = (me?.settings ?? { ...DEFAULT_SETTINGS, organization_name: "" }) as NonNullable<Me["settings"]>;
    const needsMfa = !!me && isAdminRole(me.profile.role) && me.profile.status === "active" && !!settings.require_admin_mfa && me.aal !== "aal2";
    return {
      session,
      loading: !ready || (!!session && meQ.isLoading),
      me,
      meError: (meQ.error as Error) ?? null,
      needsMfa,
      recovery,
      tz: settings.timezone || "Asia/Kolkata",
      settings,
      refreshMe: () => meQ.refetch(),
      signOut: async () => {
        try {
          await rpc("log_session_event", { p_event: "logout", p_device: navigator.userAgent.slice(0, 120) });
        } catch {
          /* best effort */
        }
        await supabase.auth.signOut();
        setRecovery(false);
      },
    };
  }, [session, ready, meQ.data, meQ.error, meQ.isLoading, recovery, meQ]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
