import { useState } from "react";
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { normalizePhone } from "@kisanroute/shared";
import { supabase } from "../supabase";
import { rpc } from "../api";
import { Banner, Button, C, Field, Muted, s } from "../ui";

const WEB_URL = process.env.EXPO_PUBLIC_WEB_URL ?? "https://aj4577.github.io/Employee_Tracker/";

function message(e: { message?: string } | null): string {
  const m = (e?.message ?? "").toLowerCase();
  if (/signups? not allowed|user not found/.test(m)) return "No account found. Please register first.";
  if (/rate|too many|seconds/.test(m)) return "Too many attempts. Wait a minute and try again.";
  if (/sms|phone provider|unsupported phone/.test(m)) return "Phone OTP isn't set up yet. Use email for now.";
  if (/expired|invalid|otp|token/.test(m)) return "That code is wrong or has expired.";
  if (/banned/.test(m)) return "This account is suspended. Contact your administrator.";
  if (/network|fetch/.test(m)) return "No internet connection.";
  return "Couldn't sign in. Please try again.";
}

/** Passwordless sign-in: OTP to email or mobile number. Accounts are created via Register (web). */
export function LoginScreen() {
  const [method, setMethod] = useState<"email" | "phone">("email");
  const [value, setValue] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async () => {
    setErr(null);
    const t = method === "email" ? value.trim().toLowerCase() : normalizePhone(value);
    if (!t || (method === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t))) return setErr(method === "email" ? "Enter a valid email." : "Enter a valid 10-digit mobile number.");
    setBusy(true);
    const { error } = method === "email"
      ? await supabase.auth.signInWithOtp({ email: t, options: { shouldCreateUser: false } })
      : await supabase.auth.signInWithOtp({ phone: t, options: { shouldCreateUser: false } });
    setBusy(false);
    if (error) return setErr(message(error));
    setSentTo(t);
    setCode("");
  };

  const verify = async () => {
    setBusy(true);
    setErr(null);
    const { error } = method === "email"
      ? await supabase.auth.verifyOtp({ email: sentTo!, token: code.trim(), type: "email" })
      : await supabase.auth.verifyOtp({ phone: sentTo!, token: code.trim(), type: "sms" });
    setBusy(false);
    if (error) return setErr(message(error));
    rpc("log_session_event", { p_event: "login", p_device: `staff-app-${Platform.OS}` }).catch(() => {});
  };

  const tab = (k: "email" | "phone", label: string) => (
    <Pressable key={k} onPress={() => { setMethod(k); setValue(""); setErr(null); setSentTo(null); }} accessibilityRole="tab" accessibilityState={{ selected: method === k }}
      style={{ flex: 1, paddingVertical: 10, borderBottomWidth: 3, borderColor: method === k ? C.green : "transparent", alignItems: "center" }}>
      <Text style={{ fontWeight: method === k ? "700" : "400", color: method === k ? C.greenDark : C.muted }}>{label}</Text>
    </Pressable>
  );

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: C.greenLight }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 20 }} keyboardShouldPersistTaps="handled">
        <View style={[s.card, { padding: 20 }]}>
          <Text style={[s.h1, { color: C.greenDark, marginBottom: 4 }]}>KisanRoute Staff</Text>
          <Muted style={{ marginBottom: 12 }}>Sign in with a one-time code.</Muted>
          {err ? <Banner kind="error">{err}</Banner> : null}
          {sentTo ? (
            <>
              <Text style={{ marginBottom: 10 }}>Code sent to {sentTo}</Text>
              <Field label="Verification code" keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" maxLength={8} value={code} onChangeText={(t) => setCode(t.replace(/\D/g, ""))} />
              <Button title="Verify & sign in" onPress={verify} busy={busy} disabled={code.length < 6} />
              <Button title={`Change ${method === "email" ? "email" : "number"}`} variant="secondary" onPress={() => setSentTo(null)} style={{ marginTop: 8 }} />
            </>
          ) : (
            <>
              <View style={{ flexDirection: "row", marginBottom: 12 }} accessibilityRole="tablist">{[tab("email", "Email"), tab("phone", "Mobile number")]}</View>
              {method === "email" ? (
                <Field label="Email" autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" value={value} onChangeText={setValue} onSubmitEditing={send} />
              ) : (
                <Field label="Mobile number" keyboardType="phone-pad" autoComplete="tel" textContentType="telephoneNumber" placeholder="98765 43210" value={value} onChangeText={setValue} onSubmitEditing={send} />
              )}
              <Button title="Send OTP" onPress={send} busy={busy} disabled={!value} />
            </>
          )}
          <Pressable onPress={() => Linking.openURL(`${WEB_URL.replace(/\/$/, "")}/register`)} accessibilityRole="link" style={{ marginTop: 16 }}>
            <Text style={{ color: C.green, fontWeight: "700" }}>New here? Register first →</Text>
          </Pressable>
          <Muted style={{ marginTop: 6 }}>After registering, an admin approves your account. Then sign in here.</Muted>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
