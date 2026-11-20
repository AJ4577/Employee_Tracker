import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fieldErrors, formatInTz, inviteInput, timeAgo, type Profile, type StaffBoardRow } from "@kisanroute/shared";
import { callFunction, rpc, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useStaffList } from "../../lib/data";
import { useToast } from "../../ui/toast";
import { Banner, Button, Empty, ErrorState, Loading, Modal, PageHeader, Select, TextArea, TextInput } from "../../ui/ui";

export default function Staff() {
  const { me } = useAuth();
  const list = useStaffList(true);
  const board = useQuery({ queryKey: ["staff-board"], queryFn: () => rpc<StaffBoardRow[]>("admin_staff_board") });
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [statusFor, setStatusFor] = useState<Profile | null>(null);
  const toast = useToast();
  const qc = useQueryClient();
  const resend = useMutation({
    mutationFn: (p: Profile) => callFunction("invite-user", { email: p.email, display_name: p.display_name, role: p.role, resend: true }),
    onSuccess: () => { toast("ok", "Invitation re-sent."); qc.invalidateQueries({ queryKey: ["staff-list"] }); },
    onError: (e: ApiError) => toast("error", e.message),
  });
  const stats = new Map((board.data ?? []).map((b) => [b.id, b]));
  const pending = (list.data ?? []).filter((p) => p.status === "pending");

  return (
    <>
      <PageHeader title="Staff" actions={<Button onClick={() => setInviting(true)}>+ Invite</Button>} />
      {pending.length ? <PendingRegistrations rows={pending} /> : null}
      {list.isLoading ? <Loading /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data?.length ? <Empty title="No team members yet" /> : (
        <div className="table-wrap">
          <table className="table cards-on-mobile">
            <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Coverage</th><th>Duty</th><th>Open / overdue</th><th>Last seen</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {list.data.map((p) => {
                const b = stats.get(p.id);
                const self = p.id === me?.profile.id;
                return (
                  <tr key={p.id}>
                    <td data-label="Name"><strong>{p.display_name}</strong><div className="small muted">{p.email}</div></td>
                    <td data-label="Role">{p.role}</td>
                    <td data-label="Status"><span className={`badge st-${p.status}`}>{p.status}</span></td>
                    <td data-label="Coverage">{p.coverage_area ?? "—"}</td>
                    <td data-label="Duty">{p.role !== "staff" ? "—" : b?.duty_id ? (b.duty_mode === "limited" ? "On duty (no GPS)" : "On duty") : "Off duty"}</td>
                    <td data-label="Open / overdue">{p.role === "staff" && b ? <Link to={`/admin/visits?staff=${p.id}`}>{b.open_visits} / {b.overdue_visits}</Link> : "—"}</td>
                    <td data-label="Last seen">{timeAgo(p.last_seen_at)}</td>
                    <td className="row">
                      {!self ? <Button variant="secondary" className="btn-sm" onClick={() => setEditing(p)}>Edit</Button> : null}
                      {p.status === "invited" ? <Button variant="ghost" className="btn-sm" busy={resend.isPending} onClick={() => resend.mutate(p)}>Resend invite</Button> : null}
                      {!self && p.role !== "owner" && p.status !== "invited" && p.status !== "pending" ? (
                        <Button variant={p.status === "active" ? "danger" : "secondary"} className="btn-sm" onClick={() => setStatusFor(p)}>{p.status === "active" ? "Suspend" : "Reactivate"}</Button>
                      ) : null}
                      {p.role === "staff" && p.status === "active" ? <Link className="btn btn-ghost btn-sm" to={`/admin/tracking?staff=${p.id}`}>Map</Link> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {inviting ? <InviteForm onClose={() => setInviting(false)} /> : null}
      {editing ? <EditStaff p={editing} staff={list.data ?? []} onClose={() => setEditing(null)} /> : null}
      {statusFor ? <StatusModal p={statusFor} onClose={() => setStatusFor(null)} /> : null}
    </>
  );
}

function PendingRegistrations({ rows }: { rows: Profile[] }) {
  const { me, tz } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [roles, setRoles] = useState<Record<string, string>>({});
  const review = useMutation({
    mutationFn: ({ id, approve, role }: { id: string; approve: boolean; role?: string }) =>
      rpc("admin_review_registration", { p_profile: id, p_approve: approve, p_role: role ?? null, p_reason: approve ? null : "Rejected by admin" }),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ["staff-list"] });
      qc.invalidateQueries({ queryKey: ["staff-board"] });
      toast("ok", v.approve ? "Approved. They can sign in now." : "Registration rejected.");
    },
    onError: (e: ApiError) => toast("error", e.message),
  });
  const owner = me?.profile.role === "owner";
  return (
    <section className="card">
      <div className="card-head"><h2>Pending registrations ({rows.length})</h2></div>
      <ul className="list">
        {rows.map((p) => {
          const role = roles[p.id] ?? (p.role === "admin" && !owner ? "staff" : p.role);
          return (
            <li key={p.id} className="list-item">
              <div>
                <strong>{p.display_name}</strong> <span className="badge st-invited">requested {p.role}</span>
                <div className="small muted">{p.email} · {p.phone ?? "no phone"} · registered {formatInTz(p.created_at, tz)}</div>
              </div>
              <div className="row">
                <Select label="Approve as" value={role} onChange={(e) => setRoles({ ...roles, [p.id]: e.target.value })}>
                  <option value="staff">Field staff</option>
                  {owner ? <option value="admin">Admin</option> : null}
                </Select>
                <Button className="btn-sm" busy={review.isPending} onClick={() => review.mutate({ id: p.id, approve: true, role })}>Approve</Button>
                <Button variant="danger" className="btn-sm" busy={review.isPending} onClick={() => review.mutate({ id: p.id, approve: false })}>Reject</Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function InviteForm({ onClose }: { onClose: () => void }) {
  const { me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ email: "", display_name: "", role: "staff", phone: "", coverage_area: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const m = useMutation({
    mutationFn: async () => {
      const parsed = inviteInput.safeParse(f);
      if (!parsed.success) { setErrors(fieldErrors(parsed.error)); throw new ApiError({ code: "validation", message: "Please fix the highlighted fields." }); }
      setErrors({});
      return callFunction<{ expires_in_hours: number }>("invite-user", parsed.data);
    },
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["staff-list"] }); toast("ok", `Invitation emailed. Link valid for ${r.expires_in_hours} hours.`); onClose(); },
    onError: (e: ApiError) => toast("error", e.message),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Modal title="Invite team member" open onClose={onClose} footer={<Button form="inv" type="submit" busy={m.isPending}>Send invitation</Button>}>
      <form id="inv" className="form-grid" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
        <TextInput label="Email" type="email" required value={f.email} onChange={set("email")} error={errors.email} />
        <TextInput label="Full name" required value={f.display_name} onChange={set("display_name")} error={errors.display_name} />
        <Select label="Role" value={f.role} onChange={set("role")}>
          <option value="staff">Field staff</option>
          {me?.profile.role === "owner" ? <option value="admin">Admin / dispatcher</option> : null}
        </Select>
        <TextInput label="Phone (optional)" value={f.phone} onChange={set("phone")} />
        <div className="span-2"><TextInput label="Coverage area (optional)" placeholder="Villages / taluka" value={f.coverage_area} onChange={set("coverage_area")} /></div>
      </form>
      <p className="small muted">They'll receive an email to set a password. No one can self-register.</p>
    </Modal>
  );
}

function EditStaff({ p, staff, onClose }: { p: Profile; staff: Profile[]; onClose: () => void }) {
  const { me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ display_name: p.display_name, phone: p.phone ?? "", coverage_area: p.coverage_area ?? "", manager_id: p.manager_id ?? "", role: p.role });
  const m = useMutation({
    mutationFn: () => {
      const patch: Record<string, unknown> = { display_name: f.display_name, phone: f.phone, coverage_area: f.coverage_area, manager_id: f.manager_id || null };
      if (me?.profile.role === "owner" && f.role !== p.role) patch.role = f.role;
      return rpc("admin_update_staff", { p_staff: p.id, p_patch: patch });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["staff-list"] }); toast("ok", "Saved."); onClose(); },
    onError: (e: ApiError) => toast("error", e.message),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Modal title={`Edit ${p.display_name}`} open onClose={onClose} footer={<Button busy={m.isPending} onClick={() => m.mutate()}>Save</Button>}>
      <div className="form-grid">
        <TextInput label="Name" value={f.display_name} onChange={set("display_name")} />
        <TextInput label="Phone" value={f.phone} onChange={set("phone")} />
        <TextInput label="Coverage area" value={f.coverage_area} onChange={set("coverage_area")} />
        <Select label="Manager" value={f.manager_id} onChange={set("manager_id")}>
          <option value="">None</option>
          {staff.filter((s) => s.id !== p.id && s.role !== "staff").map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
        </Select>
        {me?.profile.role === "owner" && p.role !== "owner" ? (
          <Select label="Role" value={f.role} onChange={set("role")}>
            <option value="staff">Field staff</option>
            <option value="admin">Admin</option>
          </Select>
        ) : null}
      </div>
    </Modal>
  );
}

function StatusModal({ p, onClose }: { p: Profile; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const suspend = p.status === "active";
  const m = useMutation({
    mutationFn: () => callFunction("admin-staff", { staff_id: p.id, action: suspend ? "suspend" : "activate", reason }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["staff-list"] }); qc.invalidateQueries({ queryKey: ["staff-board"] }); toast("ok", suspend ? "Suspended. Sessions revoked and tracking stopped." : "Reactivated."); onClose(); },
    onError: (e: ApiError) => toast("error", e.message),
  });
  return (
    <Modal title={suspend ? `Suspend ${p.display_name}?` : `Reactivate ${p.display_name}?`} open onClose={onClose} footer={<Button variant={suspend ? "danger" : "primary"} busy={m.isPending} onClick={() => m.mutate()}>{suspend ? "Suspend" : "Reactivate"}</Button>}>
      {suspend ? <Banner kind="warn">They will be signed out everywhere, lose access to all data immediately, their duty/trip will be closed and push notifications disabled. Assigned visits stay assigned — reassign them from Visits.</Banner> : null}
      <TextArea label="Reason (recorded in audit log)" value={reason} onChange={(e) => setReason(e.target.value)} />
    </Modal>
  );
}
