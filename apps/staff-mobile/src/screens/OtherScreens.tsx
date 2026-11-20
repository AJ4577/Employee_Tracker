import { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { formatInTz, type UserNotification } from "@kisanroute/shared";
import { useSession } from "../session";
import { rpc } from "../api";
import { supabase } from "../supabase";
import { Banner, Button, C, Card, Muted, s } from "../ui";

export function NotificationsScreen({ onOpenVisit }: { onOpenVisit: (id: string) => void }) {
  const { me, settings, refresh } = useSession();
  const [rows, setRows] = useState<UserNotification[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!me) return;
    setLoading(true);
    const { data, error } = await supabase.from("user_notifications").select("id,type,visit_id,title,body,read_at,created_at").eq("recipient_id", me.profile.id).order("created_at", { ascending: false }).limit(100);
    setLoading(false);
    if (error) setErr(error.message);
    else {
      setRows(data as UserNotification[]);
      setErr(null);
    }
  }, [me]);
  useEffect(() => {
    load();
  }, [load]);
  const markAll = async () => {
    await rpc("mark_notifications_read", { p_ids: null }).catch(() => {});
    await load();
    await refresh();
  };
  return (
    <ScrollView contentContainerStyle={{ padding: 16 }} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}>
      <View style={[s.row, { justifyContent: "space-between", marginBottom: 10 }]}>
        <Text style={s.h1}>Notifications</Text>
        <Button title="Mark all read" variant="secondary" onPress={markAll} disabled={!rows?.some((r) => !r.read_at)} />
      </View>
      {err ? <Banner kind="error">{err}</Banner> : null}
      {rows?.length === 0 ? <Muted>No notifications.</Muted> : null}
      {rows?.map((n) => (
        <Pressable
          key={n.id}
          onPress={async () => {
            if (!n.read_at) rpc("mark_notifications_read", { p_ids: [n.id] }).then(() => refresh()).catch(() => {});
            if (n.visit_id) onOpenVisit(n.visit_id);
          }}
          style={[s.card, !n.read_at && { borderColor: C.green, backgroundColor: C.greenLight }]}
          accessibilityRole="button"
        >
          <Text style={{ fontWeight: "700" }}>{n.title}{!n.read_at ? " · New" : ""}</Text>
          <Muted>{n.body}</Muted>
          <Muted>{formatInTz(n.created_at, settings.timezone)}</Muted>
        </Pressable>
      ))}
    </ScrollView>
  );
}

export function ProfileScreen({ pushMsg }: { pushMsg: string | null }) {
  const { me, settings, signOut } = useSession();
  const p = me?.profile;
  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <Text style={[s.h1, { marginBottom: 10 }]}>My profile</Text>
      <Card>
        <Text style={{ fontWeight: "700", fontSize: 17 }}>{p?.display_name}</Text>
        <Muted>{p?.email}</Muted>
        {p?.phone ? <Muted>{p.phone}</Muted> : null}
        {p?.coverage_area ? <Muted>Coverage: {p.coverage_area}</Muted> : null}
        <Muted>{settings.organization_name}</Muted>
      </Card>
      {pushMsg ? <Banner kind="warn">{pushMsg}</Banner> : <Banner kind="ok">Push notifications are enabled on this device.</Banner>}
      <Card title="Your location data">
        <Text style={{ lineHeight: 21 }}>
          • Collected only between Start duty and End duty; a notification shows while tracking is on.{"\n"}
          • Visible to your organization's admins only — not to other staff.{"\n"}
          • Detailed points are deleted after {settings.route_retention_days} days.{"\n"}
          • If location isn't working, keep working: arrivals will ask for a reason.{"\n"}
          • Questions: contact your administrator.
        </Text>
      </Card>
      <Button title="Sign out" variant="danger" onPress={signOut} />
      <Muted style={{ marginTop: 10 }}>Signing out ends duty, stops tracking, disables push for this device and clears offline data.</Muted>
    </ScrollView>
  );
}
