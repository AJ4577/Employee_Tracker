import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { fieldErrors, settingsPatch } from "@kisanroute/shared";
import { rpc, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useToast } from "../../ui/toast";
import { Section } from "../../ui/Layout";
import { Banner, Button, PageHeader, Select, TextInput } from "../../ui/ui";

const TZS = ["Asia/Kolkata", "Asia/Dhaka", "Asia/Kathmandu", "Asia/Colombo", "Asia/Dubai", "UTC"];

export default function Settings() {
  const { settings, me, refreshMe } = useAuth();
  const toast = useToast();
  const owner = me?.profile.role === "owner";
  const [f, setF] = useState({ ...settings });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: async () => {
      const patch: Record<string, unknown> = {};
      for (const k of Object.keys(f) as (keyof typeof f)[]) if (f[k] !== settings[k]) patch[k] = f[k];
      if (!owner) delete patch.require_admin_mfa;
      const parsed = settingsPatch.safeParse(patch);
      if (!parsed.success) { setErrors(fieldErrors(parsed.error)); throw new ApiError({ code: "validation", message: "Please fix the highlighted fields." }); }
      setErrors({});
      if (!Object.keys(parsed.data).length) return null;
      return rpc("update_org_settings", { p_patch: parsed.data });
    },
    onSuccess: (r) => { refreshMe(); toast("ok", r ? "Settings saved (audited)." : "No changes."); },
    onError: (e: ApiError) => toast("error", e.message),
  });
  const num = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value === "" ? 0 : Number(e.target.value) }));
  const txt = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const bool = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value === "1" }));

  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
      <PageHeader title="Settings" actions={<Button type="submit" busy={save.isPending}>Save changes</Button>} />
      <Section title="Organization">
        <div className="form-grid">
          <TextInput label="Organization name" value={f.organization_name} onChange={txt("organization_name")} error={errors.organization_name} />
          <TextInput label="App name" value={f.app_name} onChange={txt("app_name")} error={errors.app_name} />
          <Select label="Time zone" value={f.timezone} onChange={txt("timezone")}>
            {[...new Set([f.timezone, ...TZS])].map((t) => <option key={t}>{t}</option>)}
          </Select>
          <TextInput label="Reminder before visit (minutes)" type="number" min={0} value={f.reminder_offset_min} onChange={num("reminder_offset_min")} error={errors.reminder_offset_min} />
        </div>
      </Section>
      <Section title="Location & arrival">
        <div className="form-grid">
          <TextInput label="Arrival radius (m)" type="number" min={20} value={f.arrival_radius_m} onChange={num("arrival_radius_m")} error={errors.arrival_radius_m} hint="Outside this distance, staff must give a reason; the arrival is flagged." />
          <TextInput label="Low-accuracy threshold (m)" type="number" min={10} value={f.low_accuracy_m} onChange={num("low_accuracy_m")} error={errors.low_accuracy_m} />
          <TextInput label="Stale after (seconds)" type="number" min={60} value={f.stale_after_s} onChange={num("stale_after_s")} error={errors.stale_after_s} hint="After this, a staff marker shows 'Stale' instead of 'Live'." />
          <TextInput label="GPS sample interval (seconds)" type="number" min={10} value={f.sample_interval_s} onChange={num("sample_interval_s")} error={errors.sample_interval_s} />
          <TextInput label="GPS sample distance (m)" type="number" min={5} value={f.sample_distance_m} onChange={num("sample_distance_m")} error={errors.sample_distance_m} />
          <TextInput label="Detailed route retention (days)" type="number" min={7} value={f.route_retention_days} onChange={num("route_retention_days")} error={errors.route_retention_days} hint="Visit timestamps and audit history are kept; only raw GPS points are purged." />
        </div>
      </Section>
      <Section title="Proof & security">
        <div className="form-grid">
          <Select label="Require delivery acknowledgement" value={f.require_delivery_ack ? "1" : "0"} onChange={bool("require_delivery_ack")}><option value="0">No</option><option value="1">Yes</option></Select>
          <Select label="Require photo to complete a visit" value={f.require_photo_on_complete ? "1" : "0"} onChange={bool("require_photo_on_complete")}><option value="0">No</option><option value="1">Yes</option></Select>
          <Select label="Require MFA for admins" value={f.require_admin_mfa ? "1" : "0"} onChange={bool("require_admin_mfa")} disabled={!owner} hint={owner ? "Strongly recommended." : "Only the owner can change this."}><option value="1">Yes</option><option value="0">No</option></Select>
        </div>
      </Section>
      <Section title="Map provider">
        <Banner kind="warn">The default OpenStreetMap tile server is for light/dev use only and has no SLA. For production, use a commercial or self-hosted tile provider and update the CSP in public/_headers.</Banner>
        <div className="form-grid">
          <TextInput label="Tile URL template (https)" value={f.map_tile_url} onChange={txt("map_tile_url")} error={errors.map_tile_url} />
          <TextInput label="Attribution" value={f.map_tile_attribution} onChange={txt("map_tile_attribution")} error={errors.map_tile_attribution} />
        </div>
      </Section>
    </form>
  );
}
