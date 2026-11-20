import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from "react-native";
import { STATUS_LABEL, type VisitStatus } from "@kisanroute/shared";

export const C = {
  green: "#1f6f3a",
  greenDark: "#12432a",
  greenLight: "#e6f3ea",
  ink: "#17221b",
  muted: "#5b6b61",
  line: "#d9e3dc",
  bg: "#f6f8f6",
  warn: "#9a5b00",
  warnBg: "#fff6e5",
  danger: "#b42318",
  dangerBg: "#fdecea",
  info: "#1d4f8a",
  infoBg: "#eaf2fb",
};

export function Button({ title, onPress, variant = "primary", busy, disabled, style }: { title: string; onPress: () => void; variant?: "primary" | "secondary" | "danger"; busy?: boolean; disabled?: boolean; style?: ViewStyle }) {
  const v = variant === "primary" ? s.btnPrimary : variant === "danger" ? s.btnDanger : s.btnSecondary;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: disabled || busy, busy }} onPress={onPress} disabled={disabled || busy} style={({ pressed }) => [s.btn, v, (disabled || busy) && { opacity: 0.55 }, pressed && { opacity: 0.8 }, style]}>
      {busy ? <ActivityIndicator color={variant === "secondary" ? C.green : "#fff"} /> : null}
      <Text style={[s.btnText, variant === "secondary" && { color: C.greenDark }]}>{title}</Text>
    </Pressable>
  );
}

export function Card({ title, children, right }: { title?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <View style={s.card}>
      {title || right ? (
        <View style={s.cardHead}>
          {title ? <Text style={s.h2}>{title}</Text> : <View />}
          {right}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function Banner({ kind = "info", children }: { kind?: "info" | "warn" | "error" | "ok"; children: ReactNode }) {
  const st = kind === "warn" ? [C.warnBg, "#6b4000"] : kind === "error" ? [C.dangerBg, C.danger] : kind === "ok" ? [C.greenLight, C.greenDark] : [C.infoBg, C.info];
  return (
    <View style={[s.banner, { backgroundColor: st[0] }]} accessibilityRole={kind === "error" ? "alert" : undefined}>
      {typeof children === "string" ? <Text style={{ color: st[1] }}>{children}</Text> : children}
    </View>
  );
}

const STATUS_COLORS: Record<VisitStatus, [string, string]> = {
  assigned: [C.infoBg, C.info],
  in_progress: ["#fff3d6", "#8a5300"],
  arrived: ["#ede7fb", "#4b2a9a"],
  completed: [C.greenLight, C.greenDark],
  rescheduled: ["#f1f1f1", "#444"],
  cancelled: [C.dangerBg, C.danger],
  blocked: ["#2d2d2d", "#fff"],
};
export function StatusBadge({ status }: { status: VisitStatus }) {
  const [bg, fg] = STATUS_COLORS[status];
  return (
    <View style={[s.badge, { backgroundColor: bg }]}>
      <Text style={{ color: fg, fontWeight: "700", fontSize: 12 }}>{STATUS_LABEL[status]}</Text>
    </View>
  );
}

export function Field({ label, error, hint, ...rest }: TextInputProps & { label: string; error?: string | null; hint?: string }) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput accessibilityLabel={label} placeholderTextColor="#8a978f" style={[s.input, error ? { borderColor: C.danger } : null, rest.multiline ? { minHeight: 90, textAlignVertical: "top" } : null]} {...rest} />
      {error ? <Text style={{ color: C.danger, marginTop: 4 }}>{error}</Text> : hint ? <Text style={s.muted}>{hint}</Text> : null}
    </View>
  );
}

export function Muted({ children, style }: { children: ReactNode; style?: object }) {
  return <Text style={[s.muted, style]}>{children}</Text>;
}

export const s = StyleSheet.create({
  btn: { minHeight: 48, borderRadius: 10, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  btnPrimary: { backgroundColor: C.green },
  btnSecondary: { backgroundColor: "#fff", borderWidth: 1, borderColor: C.line },
  btnDanger: { backgroundColor: C.danger },
  btnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  card: { backgroundColor: "#fff", borderRadius: 12, borderWidth: 1, borderColor: C.line, padding: 14, marginBottom: 12 },
  cardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  h1: { fontSize: 22, fontWeight: "800", color: C.ink },
  h2: { fontSize: 17, fontWeight: "700", color: C.ink },
  banner: { padding: 12, borderRadius: 10, marginBottom: 10 },
  badge: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999, alignSelf: "flex-start" },
  label: { fontWeight: "600", marginBottom: 4, color: C.ink },
  input: { borderWidth: 1, borderColor: "#b9c7be", borderRadius: 9, minHeight: 48, paddingHorizontal: 12, fontSize: 16, backgroundColor: "#fff", color: C.ink },
  muted: { color: C.muted, fontSize: 13 },
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap", alignItems: "center" },
});
