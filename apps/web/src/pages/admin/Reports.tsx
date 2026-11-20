import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatDuration, formatINR, formatInTz, STATUS_LABEL, TASK_TYPE_LABEL, toCsv, utcToLocalInput, zonedToUtc, type TaskType, type VisitStatus } from "@kisanroute/shared";
import { rpc } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useStaffList } from "../../lib/data";
import { useToast } from "../../ui/toast";
import { Section } from "../../ui/Layout";
import { Button, Empty, ErrorState, Loading, PageHeader, Select, TextInput } from "../../ui/ui";

type Tab = "timeline" | "staff" | "products" | "exceptions";
interface TimelineRow {
  visit_id: string; scheduled_at: string; status: VisitStatus; type: TaskType; staff_name: string; farmer_name: string; village: string | null;
  departed_at: string | null; arrived_at: string | null; completed_at: string | null; return_started_at: string | null; return_ended_at: string | null;
  arrival_distance_m: number | null; arrival_flagged: boolean; arrival_reason: string | null; outcome: string | null; next_followup_at: string | null;
}

function download(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Reports() {
  const { tz } = useAuth();
  const toast = useToast();
  const today = utcToLocalInput(new Date().toISOString(), tz).slice(0, 10);
  const [tab, setTab] = useState<Tab>("timeline");
  const [fromD, setFromD] = useState(utcToLocalInput(new Date(Date.now() - 6 * 86400e3).toISOString(), tz).slice(0, 10));
  const [toD, setToD] = useState(today);
  const [staffId, setStaffId] = useState("");
  const [village, setVillage] = useState("");
  const staff = useStaffList(true);
  const [from, to] = useMemo(() => [zonedToUtc(`${fromD}T00:00`, tz).toISOString(), new Date(zonedToUtc(`${toD}T00:00`, tz).getTime() + 86400e3).toISOString()], [fromD, toD, tz]);
  const args = { p_from: from, p_to: to };

  const q = useQuery({
    queryKey: ["report", tab, from, to, staffId, village],
    queryFn: async (): Promise<Record<string, unknown>[]> => {
      if (tab === "timeline") return rpc("report_visit_timeline", { ...args, p_staff: staffId || null, p_village: village.trim() || null });
      if (tab === "staff") return rpc("report_staff_summary", args);
      if (tab === "products") return rpc("report_product_sales", args);
      return rpc("report_exceptions", args);
    },
  });

  const exportCsv = async () => {
    const rows = q.data ?? [];
    try {
      await rpc("log_export", { p_kind: `report_${tab}`, p_filters: { from, to, staff: staffId || null, village: village || null }, p_rows: rows.length });
    } catch (e) {
      return toast("error", (e as Error).message);
    }
    download(`kisanroute-${tab}-${fromD}-to-${toD}.csv`, toCsv(rows));
  };

  return (
    <>
      <PageHeader title="Reports" actions={<Button variant="secondary" onClick={exportCsv} disabled={!q.data?.length}>Export CSV</Button>} />
      <div className="tabs" role="tablist">
        {(["timeline", "staff", "products", "exceptions"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t === "timeline" ? "Visit timeline" : t === "staff" ? "Staff summary" : t === "products" ? "Product sales" : "Exceptions"}
          </button>
        ))}
      </div>
      <div className="filters">
        <TextInput label="From" type="date" value={fromD} max={toD} onChange={(e) => setFromD(e.target.value)} />
        <TextInput label="To" type="date" value={toD} min={fromD} onChange={(e) => setToD(e.target.value)} />
        {tab === "timeline" ? (
          <>
            <Select label="Staff" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
              <option value="">All</option>
              {staff.data?.filter((s) => s.role === "staff").map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
            </Select>
            <TextInput label="Village" value={village} onChange={(e) => setVillage(e.target.value)} />
          </>
        ) : null}
      </div>
      <Section>
        {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length ? <Empty title="No data for this period" /> : (
          <div className="table-wrap">
            {tab === "timeline" ? <TimelineTable rows={q.data as unknown as TimelineRow[]} tz={tz} /> : <GenericTable rows={q.data} tz={tz} />}
          </div>
        )}
      </Section>
    </>
  );
}

function TimelineTable({ rows, tz }: { rows: TimelineRow[]; tz: string }) {
  const t = (iso: string | null) => (iso ? formatInTz(iso, tz, { day: undefined, month: undefined }) : "Not recorded");
  return (
    <table className="table cards-on-mobile small">
      <thead><tr><th>Scheduled</th><th>Staff</th><th>Farmer</th><th>Status</th><th>Left (gaya)</th><th>Arrived (pahuncha)</th><th>Travel</th><th>Meeting done</th><th>Return start</th><th>Returned (wapas)</th><th>Arrival check</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.visit_id}>
            <td data-label="Scheduled"><Link to={`/admin/visits/${r.visit_id}`}>{formatInTz(r.scheduled_at, tz)}</Link></td>
            <td data-label="Staff">{r.staff_name}</td>
            <td data-label="Farmer">{r.farmer_name}{r.village ? `, ${r.village}` : ""} <span className="muted">({TASK_TYPE_LABEL[r.type]})</span></td>
            <td data-label="Status">{STATUS_LABEL[r.status]}</td>
            <td data-label="Left">{t(r.departed_at)}</td>
            <td data-label="Arrived">{t(r.arrived_at)}</td>
            <td data-label="Travel">{formatDuration(r.departed_at, r.arrived_at)}</td>
            <td data-label="Meeting done">{t(r.completed_at)}</td>
            <td data-label="Return start">{t(r.return_started_at)}</td>
            <td data-label="Returned">{t(r.return_ended_at)}</td>
            <td data-label="Arrival check">{r.arrived_at ? (r.arrival_flagged ? `⚑ ${r.arrival_reason ?? "manual"}` : "Within radius") : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function GenericTable({ rows, tz }: { rows: Record<string, unknown>[]; tz: string }) {
  const cols = Object.keys(rows[0]!).filter((c) => !c.endsWith("_id") && c !== "visit_id");
  const fmt = (c: string, v: unknown) => {
    if (v === null || v === undefined) return "—";
    if (c === "amount") return formatINR(v as string);
    if (c.endsWith("_at") && typeof v === "string") return formatInTz(v, tz);
    return String(v);
  };
  return (
    <table className="table cards-on-mobile">
      <thead><tr>{cols.map((c) => <th key={c}>{c.replace(/_/g, " ")}</th>)}</tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>{cols.map((c) => <td key={c} data-label={c.replace(/_/g, " ")}>{c === "farmer_name" && r.visit_id ? <Link to={`/admin/visits/${r.visit_id}`}>{fmt(c, r[c])}</Link> : fmt(c, r[c])}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}
