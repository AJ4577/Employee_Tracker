import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { normalizePhone } from "@kisanroute/shared";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth";
import { rpc, ApiError } from "../../lib/api";
import { Banner, Button, Select, TextInput } from "../../ui/ui";

function AuthShell({ title, children }: { title: string; children: ReactNode }) {
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

const device = () => navigator.userAgent.slice(0, 120);

/** Map Supabase Auth errors to clear, non-revealing messages. */
function authMessage(e: unknown, ctx: "login" | "register" | "phone"): string {
  const m = ((e as Error)?.message ?? "").toLowerCase();
  if (/signups? not allowed|user not found|no user/.test(m)) return "No account found. Please register first.";
  if (/rate|too many|security purposes|seconds/.test(m)) return "Too many attempts. Please wait a minute and try again.";
  if (/expired|invalid|otp|token/.test(m)) return "That code is wrong or has expired. Request a new one.";
  if (/sms|phone provider|unsupported phone|twilio|messagebird|vonage/.test(m))
    return "Phone OTP isn't set up yet (an SMS provider must be configured). Use email for now.";
  if (/banned/.test(m)) return "This account is suspended. Contact your administrator.";
  if (/fetch|network/.test(m)) return "No internet connection.";
  return ctx === "register" ? "Couldn't complete registration. Please try again." : "Couldn't sign in. Please try again.";
}

function OtpStep({ target, onVerify, onResend, onBack, busy }: { target: string; onVerify: (code: string) => void; onResend: () => void; onBack: () => void; busy: boolean }) {
  const [code, setCode] = useState("");
  const [wait, setWait] = useState(60);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  return (
    <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); onVerify(code.trim()); }}>
      <p>We sent a verification code to <strong>{target}</strong>.</p>
      <TextInput label="Verification code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6,8}" maxLength={8} required autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
      <Button type="submit" busy={busy} disabled={code.length < 6}>Verify</Button>
      <div className="row">
        <button type="button" className="link" disabled={wait > 0} onClick={() => { setWait(60); onResend(); }}>{wait > 0 ? `Resend code in ${wait}s` : "Resend code"}</button>
        <button type="button" className="link" onClick={onBack}>Change {target.includes("@") ? "email" : "number"}</button>
      </div>
    </form>
  );
}

export function LoginPage() {
  const { session, me } = useAuth();
  const [method, setMethod] = useState<"email" | "phone">("email");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [noAccount, setNoAccount] = useState(false);

  if (session && me) return <Navigate to="/" replace />;

  const target = () => (method === "email" ? email.trim().toLowerCase() : normalizePhone(phone));

  const send = async () => {
    setErr(null);
    setNoAccount(false);
    const t = target();
    if (!t || (method === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t))) return setErr(method === "email" ? "Enter a valid email." : "Enter a valid 10-digit mobile number.");
    setBusy(true);
    // shouldCreateUser: false — sign-in never creates accounts; unknown users are sent to Register.
    const { error } = method === "email"
      ? await supabase.auth.signInWithOtp({ email: t, options: { shouldCreateUser: false } })
      : await supabase.auth.signInWithOtp({ phone: t, options: { shouldCreateUser: false } });
    setBusy(false);
    if (error) {
      const msg = authMessage(error, method === "phone" ? "phone" : "login");
      if (msg.startsWith("No account")) setNoAccount(true);
      return setErr(msg);
    }
    setSentTo(t);
  };

  const verify = async (code: string) => {
    setBusy(true);
    setErr(null);
    const { error } = method === "email"
      ? await supabase.auth.verifyOtp({ email: sentTo!, token: code, type: "email" })
      : await supabase.auth.verifyOtp({ phone: sentTo!, token: code, type: "sms" });
    setBusy(false);
    if (error) return setErr(authMessage(error, "login"));
    rpc("log_session_event", { p_event: "login", p_device: device() }).catch(() => {});
  };

  return (
    <AuthShell title="Sign in">
      {err ? (
        <Banner kind="error">
          {err} {noAccount ? <Link to="/register">Register now →</Link> : null}
        </Banner>
      ) : null}
      {sentTo ? (
        <OtpStep target={sentTo} busy={busy} onVerify={verify} onResend={send} onBack={() => setSentTo(null)} />
      ) : (
        <>
          <div className="tabs" role="tablist">
            <button role="tab" type="button" aria-selected={method === "email"} className={method === "email" ? "active" : ""} onClick={() => { setMethod("email"); setErr(null); }}>Email</button>
            <button role="tab" type="button" aria-selected={method === "phone"} className={method === "phone" ? "active" : ""} onClick={() => { setMethod("phone"); setErr(null); }}>Mobile number</button>
          </div>
          <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); send(); }}>
            {method === "email" ? (
              <TextInput label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            ) : (
              <TextInput label="Mobile number" type="tel" inputMode="tel" autoComplete="tel" placeholder="98765 43210" required value={phone} onChange={(e) => setPhone(e.target.value)} />
            )}
            <Button type="submit" busy={busy}>Send OTP</Button>
          </form>
        </>
      )}
      <p className="small">New here? <Link to="/register">Register</Link> first — you can sign in after your account is created.</p>
    </AuthShell>
  );
}

type RegStep = "form" | "otp" | "phone" | "phone-otp" | "done";

// Registration details survive the email-link path (the link may open in a new tab). Cleared after registering.
const DRAFT_KEY = "kr_register_draft";
const loadDraft = (): { name: string; email: string; phone: string; role: string } | null => {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null");
    return d && Date.now() - d.at < 24 * 3600e3 ? d : null;
  } catch {
    return null;
  }
};
const saveDraft = (d: { name: string; email: string; phone: string; role: string } | null) => {
  try {
    if (d) localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...d, at: Date.now() }));
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* storage unavailable: user re-enters details */
  }
};

export function RegisterPage() {
  const { session, me, refreshMe } = useAuth();
  const nav = useNavigate();
  const [step, setStep] = useState<RegStep>("form");
  const [f, setF] = useState(() => {
    const d = loadDraft();
    return { name: d?.name ?? "", email: d?.email ?? "", phone: d?.phone ?? "", role: d?.role ?? "staff" };
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ status: string; role: string } | null>(null);
  const [phoneNote, setPhoneNote] = useState<string | null>(null);

  // Signed in (e.g. verified email earlier) but registration not finished: go straight to profile completion.
  const finishingOnly = !!session && !me;
  if (session && me && step === "form") return <Navigate to="/" replace />;

  const validate = () => {
    const e: Record<string, string> = {};
    if (f.name.trim().length < 2) e.name = "Enter your full name";
    if (!finishingOnly && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim())) e.email = "Enter a valid email";
    if (!normalizePhone(f.phone)) e.phone = "Enter a valid 10-digit mobile number";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const sendEmailOtp = async () => {
    setBusy(true);
    setErr(null);
    saveDraft(f);
    const { error } = await supabase.auth.signInWithOtp({
      email: f.email.trim().toLowerCase(),
      // If the email contains a link instead of a code, the link brings the user back here to finish.
      options: { shouldCreateUser: true, emailRedirectTo: `${location.origin}${import.meta.env.BASE_URL}register` },
    });
    setBusy(false);
    if (error) return setErr(authMessage(error, "register"));
    setStep("otp");
  };

  const createProfile = async () => {
    const r = await rpc<{ status: string; role: string }>("register_profile", { p_display_name: f.name.trim(), p_phone: f.phone, p_role: f.role });
    setResult(r);
    saveDraft(null);
    rpc("log_session_event", { p_event: "login", p_device: device() }).catch(() => {});
    setStep("phone");
  };

  const submitForm = async (e: FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    if (finishingOnly) {
      setBusy(true);
      setErr(null);
      try {
        await createProfile();
      } catch (x) {
        setErr(x instanceof ApiError ? (x.code === "already_registered" ? "You're already registered. Please sign in." : x.message) : authMessage(x, "register"));
      } finally {
        setBusy(false);
      }
      return;
    }
    sendEmailOtp();
  };

  const verifyEmail = async (code: string) => {
    setBusy(true);
    setErr(null);
    const { error } = await supabase.auth.verifyOtp({ email: f.email.trim().toLowerCase(), token: code, type: "email" });
    if (error) {
      setBusy(false);
      return setErr(authMessage(error, "register"));
    }
    try {
      await createProfile();
    } catch (x) {
      const ae = x as ApiError;
      if (ae.code === "already_registered") {
        await refreshMe();
        nav("/", { replace: true });
        return;
      }
      setErr(ae.message);
      setStep("form");
    } finally {
      setBusy(false);
    }
  };

  // Optional: verify the phone with Supabase Auth so "Sign in with mobile number" works.
  const sendPhoneOtp = async () => {
    setBusy(true);
    setErr(null);
    const { error } = await supabase.auth.updateUser({ phone: normalizePhone(f.phone)! });
    setBusy(false);
    if (error) {
      setPhoneNote(authMessage(error, "phone"));
      return setStep("done");
    }
    setStep("phone-otp");
  };
  const verifyPhone = async (code: string) => {
    setBusy(true);
    const { error } = await supabase.auth.verifyOtp({ phone: normalizePhone(f.phone)!, token: code, type: "phone_change" });
    setBusy(false);
    if (error) return setErr(authMessage(error, "phone"));
    setPhoneNote("Mobile number verified — you can sign in with it next time.");
    setStep("done");
  };

  const finish = async () => {
    await refreshMe();
    nav("/", { replace: true });
  };

  return (
    <AuthShell title={step === "done" || step === "phone" || step === "phone-otp" ? "Registration complete" : "Register"}>
      {err ? <Banner kind="error">{err}</Banner> : null}

      {step === "form" ? (
        <form className="stack" onSubmit={submitForm} noValidate>
          {finishingOnly ? <Banner kind="info">Email verified ({session?.user.email}). Complete your details to finish registering.</Banner> : null}
          <TextInput label="Full name" required autoComplete="name" value={f.name} error={errors.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          {!finishingOnly ? <TextInput label="Email" type="email" required autoComplete="email" value={f.email} error={errors.email} onChange={(e) => setF({ ...f, email: e.target.value })} /> : null}
          <TextInput label="Mobile number" type="tel" inputMode="tel" required autoComplete="tel" placeholder="98765 43210" value={f.phone} error={errors.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          <Select label="Register as" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} hint="Admin requests must be approved by the owner; staff requests by an admin.">
            <option value="staff">Field staff</option>
            <option value="admin">Admin</option>
          </Select>
          <Button type="submit" busy={busy}>{finishingOnly ? "Finish registration" : "Send email OTP"}</Button>
          <p className="small">Already registered? <Link to="/login">Sign in</Link></p>
        </form>
      ) : null}

      {step === "otp" ? <OtpStep target={f.email.trim().toLowerCase()} busy={busy} onVerify={verifyEmail} onResend={sendEmailOtp} onBack={() => setStep("form")} /> : null}

      {step === "phone" || step === "phone-otp" || step === "done" ? (
        <div className="stack">
          {result?.status === "active" ? (
            <Banner kind="ok">Your account is active. You are the <strong>owner</strong> of this workspace.</Banner>
          ) : (
            <Banner kind="info">Registration saved. Your {result?.role === "admin" ? "admin" : "staff"} account is <strong>waiting for approval</strong>. You can sign in once it's approved.</Banner>
          )}
          {step === "phone" ? (
            <>
              <p>Verify your mobile number to enable “Sign in with mobile number” (optional).</p>
              <Button variant="secondary" busy={busy} onClick={sendPhoneOtp}>Send OTP to {normalizePhone(f.phone)}</Button>
              <Button variant="ghost" onClick={() => setStep("done")}>Skip — I'll use email</Button>
            </>
          ) : null}
          {step === "phone-otp" ? <OtpStep target={normalizePhone(f.phone)!} busy={busy} onVerify={verifyPhone} onResend={sendPhoneOtp} onBack={() => setStep("done")} /> : null}
          {step === "done" ? (
            <>
              {phoneNote ? <Banner kind={phoneNote.startsWith("Mobile number verified") ? "ok" : "warn"}>{phoneNote}</Banner> : null}
              <Button onClick={finish}>Continue</Button>
            </>
          ) : null}
        </div>
      ) : null}
    </AuthShell>
  );
}

export function PendingApprovalPage() {
  const { me, signOut, refreshMe } = useAuth();
  const [busy, setBusy] = useState(false);
  return (
    <AuthShell title="Waiting for approval">
      <Banner kind="info">
        Hi {me?.profile.display_name}, your {me?.profile.role === "admin" ? "admin" : "staff"} registration has been received. An {me?.profile.role === "admin" ? "owner" : "admin"} must approve it before you can use the app.
      </Banner>
      <Button variant="secondary" busy={busy} onClick={async () => { setBusy(true); await refreshMe(); setBusy(false); }}>Check again</Button>
      <button className="link" onClick={() => signOut()}>Sign out</button>
    </AuthShell>
  );
}

/** Admin invitation link (optional path): activates the invited account; sign-in afterwards is by OTP. */
export function AcceptInvitePage() {
  const { session, loading, refreshMe } = useAuth();
  const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), 2500);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (!session) return;
    rpc("accept_invitation")
      .then(async () => {
        await refreshMe();
        nav("/", { replace: true });
      })
      .catch((e: ApiError) => setErr(e.message));
  }, [session, nav, refreshMe]);
  if (loading || (!session && !waited)) return <AuthShell title="Accept invitation"><p>Checking your invitation link…</p></AuthShell>;
  if (!session || err)
    return (
      <AuthShell title="Invitation link problem">
        <Banner kind="error">{err ?? "This invitation link is invalid or has expired. Ask your administrator to send a new invitation."}</Banner>
        <Link to="/login">Go to sign in</Link>
      </AuthShell>
    );
  return <AuthShell title="Accept invitation"><p>Activating your account…</p></AuthShell>;
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
        for (const f of data.all.filter((x) => x.status !== "verified")) await supabase.auth.mfa.unenroll({ factorId: f.id });
        const { data: en, error: enErr } = await supabase.auth.mfa.enroll({ factorType: "totp", issuer: "KisanRoute", friendlyName: `Google Authenticator ${new Date().toISOString().slice(0, 10)}` });
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
          <p>Admin accounts are protected with <strong>Google Authenticator</strong>.</p>
          <ol className="small">
            <li>
              Install Google Authenticator:{" "}
              <a href="https://play.google.com/store/apps/details?id=com.google.android.apps.authenticator2" target="_blank" rel="noopener noreferrer">Android</a> ·{" "}
              <a href="https://apps.apple.com/app/google-authenticator/id388497605" target="_blank" rel="noopener noreferrer">iPhone</a>
            </li>
            <li>Open it, tap <strong>+</strong> → <strong>Scan a QR code</strong>, and scan the code below.</li>
            <li>Enter the 6-digit code shown for <strong>KisanRoute</strong>.</li>
          </ol>
          <img src={qr} alt="Authenticator QR code" width={180} height={180} className="qr" />
          <p className="small muted">Can't scan? In Google Authenticator choose “Enter a setup key” and type: <code>{secret}</code></p>
        </div>
      ) : null}
      {err ? <Banner kind="error">{err}</Banner> : null}
      {factorId ? (
        <form onSubmit={verify} className="stack">
          <TextInput label="6-digit code from Google Authenticator" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          <Button type="submit" busy={busy}>Verify</Button>
        </form>
      ) : null}
      <button className="link" onClick={() => signOut()}>Sign out</button>
    </AuthShell>
  );
}
