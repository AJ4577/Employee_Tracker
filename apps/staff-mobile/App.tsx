import { useEffect, useState } from "react";
import { BackHandler, Pressable, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { isAdminRole } from "@kisanroute/shared";
import { configError } from "./src/supabase";
import { SessionProvider, useSession } from "./src/session";
import { startSyncLoop, flush } from "./src/sync";
import { registerForPush, onNotificationOpen } from "./src/push";
import { LoginScreen } from "./src/screens/LoginScreen";
import { DutyPanel, VisitList } from "./src/screens/TodayScreen";
import { VisitScreen } from "./src/screens/VisitScreen";
import { NotificationsScreen, ProfileScreen } from "./src/screens/OtherScreens";
import { Banner, Button, C, s } from "./src/ui";

type Tab = "today" | "visits" | "history" | "alerts" | "profile";

function Main() {
  const { session, ready, me, meError, offline, signOut } = useSession();
  const [tab, setTab] = useState<Tab>("today");
  const [visitId, setVisitId] = useState<string | null>(null);
  const [pushMsg, setPushMsg] = useState<string | null>(null);

  useEffect(() => onNotificationOpen((v) => v && setVisitId(v)), []);
  useEffect(() => {
    if (me?.profile.status === "active") {
      startSyncLoop();
      flush().catch(() => {});
      registerForPush().then(setPushMsg);
    }
  }, [me?.profile.id, me?.profile.status]);
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (visitId) {
        setVisitId(null);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [visitId]);

  if (configError) return <Banner kind="error">{configError}</Banner>;
  if (!ready) return null;
  if (!session) return <LoginScreen />;
  if (!me)
    return (
      <View style={{ padding: 20 }}>
        {meError ? <Banner kind="error">{meError}</Banner> : <Text>Loading…</Text>}
        {meError ? <Button title="Sign out" variant="secondary" onPress={signOut} /> : null}
      </View>
    );
  if (me.profile.status !== "active" || isAdminRole(me.profile.role))
    return (
      <View style={{ padding: 20 }}>
        <Banner kind="error">{me.profile.status === "invited" ? "Finish setting up your account from the invitation email first." : me.profile.status === "suspended" ? "This account is suspended." : "This app is for field staff. Admins should use the web app."}</Banner>
        <Button title="Sign out" variant="secondary" onPress={signOut} />
      </View>
    );

  const body = visitId ? (
    <VisitScreen id={visitId} onBack={() => setVisitId(null)} />
  ) : tab === "today" ? (
    <VisitList scope="today" onOpen={setVisitId} header={<><Text style={[s.h1, { marginBottom: 10 }]}>Namaste, {me.profile.display_name.split(" ")[0]}</Text><DutyPanel /></>} />
  ) : tab === "visits" ? (
    <VisitList scope="open" onOpen={setVisitId} />
  ) : tab === "history" ? (
    <VisitList scope="history" onOpen={setVisitId} />
  ) : tab === "alerts" ? (
    <NotificationsScreen onOpenVisit={setVisitId} />
  ) : (
    <ProfileScreen pushMsg={pushMsg} />
  );

  const tabs: [Tab, string, string][] = [
    ["today", "☀", "Today"],
    ["visits", "☑", "Visits"],
    ["history", "↺", "History"],
    ["alerts", "🔔", me.unread_notifications ? `Alerts (${me.unread_notifications})` : "Alerts"],
    ["profile", "☺", "Profile"],
  ];
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {offline ? <View style={{ backgroundColor: C.warnBg, padding: 6 }}><Text style={{ color: C.warn, textAlign: "center" }}>Offline — changes are saved and will sync</Text></View> : null}
      <View style={{ flex: 1 }}>{body}</View>
      <View style={{ flexDirection: "row", borderTopWidth: 1, borderColor: C.line, backgroundColor: "#fff" }} accessibilityRole="tablist">
        {tabs.map(([k, icon, label]) => (
          <Pressable key={k} onPress={() => { setVisitId(null); setTab(k); }} accessibilityRole="tab" accessibilityState={{ selected: tab === k && !visitId }} style={{ flex: 1, alignItems: "center", paddingVertical: 8, minHeight: 56 }}>
            <Text style={{ fontSize: 18 }}>{icon}</Text>
            <Text style={{ fontSize: 11, color: tab === k ? C.green : C.muted, fontWeight: tab === k ? "700" : "400" }}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: "#fff" }} edges={["top", "bottom"]}>
        <StatusBar style="dark" />
        <SessionProvider>
          <Main />
        </SessionProvider>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
