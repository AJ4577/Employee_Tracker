import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth";
import { rpc, ApiError } from "../../lib/api";
import { Banner, Button, TextInput } from "../../ui/ui";

function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  const { settings } = useAuth();
  return (
    <main className="auth-shell">
      <div className="auth-card">
        <div className="brand brand-lg">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={36} height={36} />
          <span>{settings.app_name || "KisanRoute"}</span>
        </div>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

const PASSWORD_RULE = "At least 10 characters with upper- and lower-case letters and a number.";
const strong = (p: string) => p.length >= 10 && /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p);

export function LoginPage() {
  const { session, me } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"login" | "reset">("login");
  const [sent, setSent] = useState(false);

  if (session && me) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      if (mode === "reset") {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${location.origin}${import.meta.env.BASE_URL}reset-password` });
        if (error) throw error;
        setSent(true);
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
        rpc("log_session_event", { p_event: "login", p_device: navigator.userAgent.slice(0, 120) }).catch(() => {});
      }
    } catch (e) {
      const m = (e as Error).message;
      // Generic message: do not reveal whether the account exists.
      setErr(/banned/i.test(m) ? "This account is suspended. Contact your administrator." : /rate|too many/i.test(m) ? "Too many attempts. Wait a minute and try again." : mode === "reset" ? "Could not send the reset email. Try again later." : "Email or password is incorrect.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title={mode === "login" ? "Sign in" : "Reset password"}>
      {err ? <Banner kind="error">{err}</Banner> : null}
      {sent ? <Banner kind="ok">If an account exists for that email, a reset link has been sent.</Banner> : null}
      <form onSubmit={submit} className="stack">
        <TextInput label="Work email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        {mode === "login" ? (
          <TextInput label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        ) : null}
        <Button type="submit" busy={busy}>
          {mode === "login" ? "Sign in" : "Send reset link"}
        </Button>
      </form>
      <button className="link" onClick={() => { setMode(mode === "login" ? "reset" : "login"); setErr(null); setSent(false); }}>
        {mode === "login" ? "Forgot password?" : "Back to sign in"}
      </button>
      <p className="muted small">Accounts are created by invitation only. Ask your administrator if you need access.</p>
    </AuthShell>
  );
}

function SetPasswordForm({ onDone, cta }: { onDone: () => Promise<void>; cta: string }) {
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!strong(p1)) return setErr(PASSWORD_RULE);
    if (p1 !== p2) return setErr("Passwords don't match.");
    setBusy(true);
    setErr(null);
    try {
      const { error } = await supabase.auth.updateUser({ password: p1 });
      if (error) throw error;
      await onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="stack">
      {err ? <Banner kind="error">{err}</Banner> : null}
      <TextInput label="New password" type="password" autoComplete="new-password" hint={PASSWORD_RULE} required value={p1} onChange={(e) => setP1(e.target.value)} />
      <TextInput label="Confirm password" type="password" autoComplete="new-password" required value={p2} onChange={(e) => setP2(e.target.value)} />
      <Button type="submit" busy={busy}>
        {cta}
      </Button>
    </form>
  );
}

export function AcceptInvitePage() {
  const { session, loading, refreshMe } = useAuth();
  const nav = useNavigate();
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), 2500);
    return () => clearTimeout(t);
  }, []);
  if (loading || (!session && !waited)) return <AuthShell title="Accept invitation"><p>Checking your invitation link…</p></AuthShell>;
  if (!session)
    return (
      <AuthShell title="Invitation link problem">
        <Banner kind="error">This invitation link is invalid or has expired. Ask your administrator to send a new invitation.</Banner>
      </AuthShell>
    );
  return (
    <AuthShell title="Welcome — set your password">
      <p className="muted">Signed in as {session.user.email}. Choose a password to activate your account.</p>
      <SetPasswordForm
        cta="Activate account"
        onDone={async () => {
          await rpc("accept_invitation");
          await refreshMe();
          nav("/", { replace: true });
        }}
      />
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const { session, recovery } = useAuth();
  const nav = useNavigate();
  if (!session && !recovery)
    return (
      <AuthShell title="Reset password">
        <Banner kind="warn">Open the reset link from your email on this device. Links expire after a short time.</Banner>
      </AuthShell>
    );
  return (
    <AuthShell title="Choose a new password">
      <SetPasswordForm
        cta="Save password"
        onDone={async () => {
          rpc("log_session_event", { p_event: "password_reset" }).catch(() => {});
          nav("/", { replace: true });
        }}
      />
    </AuthShell>
  );
}

/** TOTP MFA: enroll on first admin login, then challenge on every new session. */
export function MfaPage() {
  const { refreshMe, signOut } = useAuth();
  const nav = useNavigate();
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) {
        setErr(error.message);
        setLoading(false);
        return;
      }
      const verified = data.totp.find((f) => f.status === "verified");
      if (verified) setFactorId(verified.id);
      else {
        // Clean up abandoned enrolments, then enroll fresh.
        for (const f of data.all.filter((x) => x.status !== "verified")) await supabase.auth.mfa.unenroll({ factorId: f.id });
        const { data: en, error: enErr } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: `KisanRoute ${new Date().toISOString().slice(0, 10)}` });
        if (enErr) setErr(enErr.message);
        else {
          setFactorId(en.id);
          setQr(en.totp.qr_code);
          setSecret(en.totp.secret);
        }
      }
      setLoading(false);
    })();
  }, []);

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    if (!factorId) return;
    setBusy(true);
    setErr(null);
    try {
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
      if (error) throw error;
      rpc("log_session_event", { p_event: "mfa_verified" }).catch(() => {});
      await refreshMe();
      nav("/", { replace: true });
    } catch {
      setErr("That code didn't work. Check your authenticator app's time and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Two-step verification">
      {loading ? <p>Preparing…</p> : null}
      {qr ? (
        <div className="stack">
          <p>Admin accounts require an authenticator app (Google Authenticator, Microsoft Authenticator, Authy). Scan this code:</p>
          <img src={qr} alt="Authenticator QR code" width={180} height={180} className="qr" />
          <p className="small muted">
            Can't scan? Enter this key: <code>{secret}</code>
          </p>
        </div>
      ) : null}
      {err ? <Banner kind="error">{err}</Banner> : null}
      {factorId ? (
        <form onSubmit={verify} className="stack">
          <TextInput label="6-digit code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          <Button type="submit" busy={busy}>
            Verify
          </Button>
        </form>
      ) : null}
      <button className="link" onClick={() => signOut()}>
        Sign out
      </button>
    </AuthShell>
  );
}
