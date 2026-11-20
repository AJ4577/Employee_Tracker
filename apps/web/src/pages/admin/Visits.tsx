import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fieldErrors,
  formatInTz,
  PRIORITIES,
  STATUS_LABEL,
  TASK_TYPE_LABEL,
  TASK_TYPES,
  utcToLocalInput,
  VISIT_STATUSES,
  visitCreateInput,
  zonedToUtc,
  type Visit,
  type VisitStatus,
} from "@kisanroute/shared";
import { supabase } from "../../lib/supabase";
import { must, rpc, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useActiveProducts, useFarmerOptions, useStaffList } from "../../lib/data";
import { useToast } from "../../ui/toast";
import { Banner, Button, Empty, ErrorState, Loading, Modal, PageHeader, Pager, Select, StatusBadge, TextArea, TextInput } from "../../ui/ui";

const PAGE = 25;
type Row = Visit & { farmer: { name: string; village: string | null } | null; staff: { display_name: string } | null };

export default function Visits() {
  const { tz } = useAuth();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<string>(params.get("status") ?? "");
  const [staffId, setStaffId] = useState(params.get("staff") ?? "");
  const [date, setDate] = useState(params.get("date") ?? "");
  const [page, setPage] = useState(0);
  const staff = useStaffList(true);
  const showNew = params.get("new") === "1";

  const q = useQuery({
    queryKey: ["visits", status, staffId, date, page],
    queryFn: async () => {
      let qb = supabase.from("visits").select("*, farmer:farmers(name,village), staff:profiles(display_name)").order("scheduled_at", { ascending: false }).range(page * PAGE, page * PAGE + PAGE);
      if (status === "overdue") qb = qb.in("status", ["assigned", "rescheduled", "in_progress", "arrived", "blocked"]).lt("scheduled_at", new Date(Date.now() - 2 * 3600e3).toISOString());
      else if (status) qb = qb.eq("status", status);
      if (staffId) qb = qb.eq("staff_id", staffId);
      if (date) {
        const start = zonedToUtc(`${date}T00:00`, tz);
        qb = qb.gte("scheduled_at", start.toISOString()).lt("scheduled_at", new Date(start.getTime() + 86400e3).toISOString());
      }
      return must<Row[]>(qb);
    },
  });
  const rows = q.data?.slice(0, PAGE) ?? [];

  return (
    <>
      <PageHeader title="Visits & tasks" actions={<Button onClick={() => setParams({ new: "1" })}>+ Assign visit</Button>} />
      <div className="filters">
        <Select label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
          <option value="">All statuses</option>
          <option value="overdue">Overdue (open, past schedule)</option>
          {VISIT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
        <Select label="Staff" value={staffId} onChange={(e) => { setStaffId(e.target.value); setPage(0); }}>
          <option value="">All staff</option>
          {staff.data?.filter((s) => s.role === "staff").map((s) => (
            <option key={s.id} value={s.id}>
              {s.display_name}
            </option>
          ))}
        </Select>
        <TextInput label="Date" type="date" value={date} onChange={(e) => { setDate(e.target.value); setPage(0); }} />
      </div>

      {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !rows.length ? <Empty title="No visits match these filters" /> : (
        <div className="table-wrap">
          <table className="table cards-on-mobile">
            <thead>
              <tr>
                <th>Scheduled</th>
                <th>Farmer</th>
                <th>Staff</th>
                <th>Type</th>
                <th>Priority</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id}>
                  <td data-label="Scheduled">
                    <Link to={`/admin/visits/${v.id}`}>{formatInTz(v.scheduled_at, v.timezone)}</Link>
                  </td>
                  <td data-label="Farmer">
                    {v.farmer?.name}
                    {v.farmer?.village ? <span className="muted"> · {v.farmer.village}</span> : null}
                  </td>
                  <td data-label="Staff">{v.staff?.display_name}</td>
                  <td data-label="Type">{TASK_TYPE_LABEL[v.type]}</td>
                  <td data-label="Priority">
                    <span className={`prio prio-${v.priority}`}>{v.priority}</span>
                  </td>
                  <td data-label="Status">
                    <StatusBadge status={v.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={page} hasMore={(q.data?.length ?? 0) > PAGE} onPage={setPage} />
      <VisitForm open={showNew} onClose={() => setParams({})} />
    </>
  );
}

export function VisitForm({ open, onClose, presetFarmer }: { open: boolean; onClose: () => void; presetFarmer?: string }) {
  const { tz } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const qc = useQueryClient();
  const farmers = useFarmerOptions();
  const staff = useStaffList();
  const products = useActiveProducts();
  const [farmerQ, setFarmerQ] = useState("");
  const [form, setForm] = useState(() => ({
    farmer_id: presetFarmer ?? "",
    staff_id: "",
    type: "meeting",
    priority: "normal",
    scheduled_local: utcToLocalInput(new Date(Date.now() + 3600e3).toISOString(), tz),
    due_local: "",
    instructions: "",
    product_ids: [] as string[],
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [warnings, setWarnings] = useState<{ code: string; message: string }[]>([]);

  const farmerList = useMemo(() => {
    const t = farmerQ.trim().toLowerCase();
    const all = farmers.data ?? [];
    return (t ? all.filter((f) => f.name.toLowerCase().includes(t) || (f.village ?? "").toLowerCase().includes(t) || (f.normalized_phone ?? "").includes(t)) : all).slice(0, 200);
  }, [farmers.data, farmerQ]);
  const chosen = farmers.data?.find((f) => f.id === form.farmer_id);

  const create = useMutation({
    mutationFn: async () => {
      const payload = {
        farmer_id: form.farmer_id,
        staff_id: form.staff_id,
        type: form.type,
        priority: form.priority,
        timezone: tz,
        scheduled_at: form.scheduled_local ? zonedToUtc(form.scheduled_local, tz).toISOString() : "",
        due_at: form.due_local ? zonedToUtc(form.due_local, tz).toISOString() : null,
        instructions: form.instructions,
        product_ids: form.product_ids,
      };
      const parsed = visitCreateInput.safeParse(payload);
      if (!parsed.success) {
        setErrors(fieldErrors(parsed.error));
        throw new ApiError({ code: "validation", message: "Please fix the highlighted fields." });
      }
      setErrors({});
      return rpc<{ visit: Visit; warnings: { code: string; message: string }[] }>("admin_create_visit", { p: parsed.data });
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["visits"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      setWarnings(r.warnings);
      toast("ok", "Visit assigned. The staff member has been notified.");
      if (!r.warnings.length) {
        onClose();
        nav(`/admin/visits/${r.visit.id}`);
      }
    },
    onError: (e: ApiError) => toast("error", e.message),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!create.isPending) create.mutate();
  };
  const set = (k: keyof typeof form, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Modal title="Assign a visit" open={open} onClose={onClose} wide footer={warnings.length ? <Button onClick={() => { onClose(); setWarnings([]); }}>Done</Button> : <Button form="visit-form" type="submit" busy={create.isPending}>Assign visit</Button>}>
      {warnings.length ? (
        <Banner kind="warn">
          Visit created with warnings:
          <ul>{warnings.map((w) => <li key={w.code}>{w.message}</li>)}</ul>
        </Banner>
      ) : (
        <form id="visit-form" onSubmit={submit} className="form-grid">
          <div className="span-2">
            <TextInput label="Find farmer" placeholder="Name, village or phone" value={farmerQ} onChange={(e) => setFarmerQ(e.target.value)} />
            <Select label="Farmer" required value={form.farmer_id} error={errors.farmer_id} onChange={(e) => set("farmer_id", e.target.value)}>
              <option value="">Choose a farmer…</option>
              {farmerList.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                  {f.village ? ` — ${f.village}` : ""}
                  {f.lat === null ? " (no pin)" : f.location_verified ? "" : " (pin not confirmed)"}
                </option>
              ))}
            </Select>
            {chosen && chosen.lat === null ? <Banner kind="warn">This farmer has no map pin. Set and confirm it on the farmer page so staff can navigate.</Banner> : null}
          </div>
          <Select label="Assign to" required value={form.staff_id} error={errors.staff_id} onChange={(e) => set("staff_id", e.target.value)}>
            <option value="">Choose staff…</option>
            {staff.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.display_name}
                {s.coverage_area ? ` — ${s.coverage_area}` : ""}
              </option>
            ))}
          </Select>
          <Select label="Task type" value={form.type} onChange={(e) => set("type", e.target.value)}>
            {TASK_TYPES.map((t) => (
              <option key={t} value={t}>
                {TASK_TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
          <TextInput label={`Scheduled (${tz})`} type="datetime-local" required value={form.scheduled_local} error={errors.scheduled_at} onChange={(e) => set("scheduled_local", e.target.value)} />
          <TextInput label="Due by (optional)" type="datetime-local" value={form.due_local} error={errors.due_at} onChange={(e) => set("due_local", e.target.value)} />
          <Select label="Priority" value={form.priority} onChange={(e) => set("priority", e.target.value)}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
          <fieldset className="span-2 checks">
            <legend>Products to discuss / deliver (optional)</legend>
            {products.data?.map((p) => (
              <label key={p.id}>
                <input
                  type="checkbox"
                  checked={form.product_ids.includes(p.id)}
                  onChange={(e) => set("product_ids", e.target.checked ? [...form.product_ids, p.id] : form.product_ids.filter((x) => x !== p.id))}
                />
                {p.name}
              </label>
            ))}
            {!products.data?.length ? <span className="muted small">No active products.</span> : null}
          </fieldset>
          <div className="span-2">
            <TextArea label="Instructions for staff" maxLength={4000} value={form.instructions} error={errors.instructions} onChange={(e) => set("instructions", e.target.value)} />
          </div>
        </form>
      )}
    </Modal>
  );
}

export const OPEN: VisitStatus[] = ["assigned", "rescheduled", "in_progress", "arrived", "blocked"];
