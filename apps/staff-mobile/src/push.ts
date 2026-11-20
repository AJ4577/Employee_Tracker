import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { rpc } from "./api";
import { kvGet, kvSet } from "./db";

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: true }),
});

/** Register this device for push. Returns a message if push is unavailable (never fakes success). */
export async function registerForPush(): Promise<string | null> {
  if (!Device.isDevice) return "Push notifications need a physical device.";
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("visits", { name: "Visits", importance: Notifications.AndroidImportance.HIGH, lightColor: "#1f6f3a" });
  }
  const cur = await Notifications.getPermissionsAsync();
  let granted = cur.granted;
  if (!granted) granted = (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) return "Notifications are turned off. You'll still see new visits in the app.";
  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId || String(projectId).startsWith("REPLACE")) return "Push not configured for this build (EAS project ID missing).";
  try {
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    await rpc("register_push_token", { p_token: token, p_platform: Platform.OS === "ios" ? "ios" : "android" });
    await kvSet("push_token", token);
    return null;
  } catch (e) {
    return `Push registration failed: ${(e as Error).message}`;
  }
}

export async function unregisterPush(): Promise<void> {
  const token = await kvGet("push_token");
  if (token) {
    try {
      await rpc("revoke_push_token", { p_token: token });
    } catch {
      /* best effort; server also disables tokens for suspended users */
    }
    await kvSet("push_token", null);
  }
}

/** Deep link: tapping a notification opens the related visit (details fetched after auth). */
export function onNotificationOpen(cb: (visitId: string | null) => void): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((r) => {
    const v = (r.notification.request.content.data as { visit_id?: string } | undefined)?.visit_id ?? null;
    cb(v);
  });
  Notifications.getLastNotificationResponseAsync().then((r) => {
    const v = (r?.notification.request.content.data as { visit_id?: string } | undefined)?.visit_id;
    if (v) cb(v);
  });
  return () => sub.remove();
}
