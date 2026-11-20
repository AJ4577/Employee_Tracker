import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from "react-native";
import { supabase } from "../supabase";
import { rpc } from "../api";
import { Banner, Button, C, Field, Muted, s } from "../ui";

export function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) {
      setErr(/banned/i.test(error.message) ? "This account is suspended. Contact your administrator." : /network|fetch/i.test(error.message) ? "No internet connection." : "Email or password is incorrect.");
      return;
    }
    rpc("log_session_event", { p_event: "login", p_device: `staff-app-${Platform.OS}` }).catch(() => {});
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: C.greenLight }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 20 }} keyboardShouldPersistTaps="handled">
        <View style={[s.card, { padding: 20 }]}>
          <Text style={[s.h1, { color: C.greenDark, marginBottom: 4 }]}>KisanRoute Staff</Text>
          <Muted style={{ marginBottom: 16 }}>Sign in with the account your administrator invited.</Muted>
          {err ? <Banner kind="error">{err}</Banner> : null}
          <Field label="Work email" autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" value={email} onChangeText={setEmail} />
          <Field label="Password" secureTextEntry autoComplete="password" textContentType="password" value={password} onChangeText={setPassword} onSubmitEditing={submit} />
          <Button title="Sign in" onPress={submit} busy={busy} disabled={!email || !password} />
          <Muted style={{ marginTop: 14 }}>First time? Open the invitation email on this phone or a computer to set your password, then sign in here. Forgot your password? Use “Forgot password” on the web app.</Muted>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
