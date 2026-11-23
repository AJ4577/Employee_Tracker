import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { distributorInput, fieldErrors, maskPhone, type Distributor } from "@kisanroute/shared";
import { supabase } from "../../lib/supabase";
import { must, rpc, ApiError } from "../../lib/api";
import { geocodeFarmerAddress } from "../../lib/googlePlaces";
import { useDebounced } from "../../lib/hooks";
import { ilikeSafe } from "../../lib/data";
import { useToast } from "../../ui/toast";
import { Button, Empty, ErrorState, Loading, Modal, PageHeader, Pager, TextArea, TextInput } from "../../ui/ui";

const PAGE = 25;

export default function Distributors() {
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const dq = useDebounced(q);

  const list = useQuery({
    queryKey: ["distributors", dq, showArchived, page],
    queryFn: () => {
      let qb = supabase.from("distributors").select("*").eq("active", !showArchived).order("name").range(page * PAGE, page * PAGE + PAGE);
      const t = ilikeSafe(dq);
      if (t) {
        const digits = t.replace(/\D/g, "");
        qb = qb.or([`name.ilike.*${t}*`, `village.ilike.*${t}*`, `district.ilike.*${t}*`, `contact_person.ilike.*${t}*`, digits.length >= 4 ? `normalized_phone.ilike.*${digits}*` : null].filter(Boolean).join(","));
      }
      return must<Distributor[]>(qb);
    },
  });
  const rows = list.data?.slice(0, PAGE) ?? [];

  return (
    <>
      <PageHeader title="Distributors" sub="Dealers and distributors you supply products to." actions={<Button onClick={() => setCreating(true)}>+ Add distributor</Button>} />
      <div className="filters">
        <TextInput label="Search" type="search" placeholder="Name, contact, place or phone" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
        <label className="check-inline">
          <input type="checkbox" checked={showArchived} onChange={(e) => { setShowArchived(e.target.checked); setPage(0); }} /> Show archived
        </label>
      </div>
      {list.isLoading ? <Loading /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !rows.length ? <Empty title="No distributors yet">Add your first distributor to record product supplies.</Empty> : (
        <div className="table-wrap">
          <table className="table cards-on-mobile">
            <thead>
              <tr><th>Name</th><th>Contact</th><th>Phone</th><th>Place</th><th>Map</th></tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td data-label="Name"><Link to={`/admin/distributors/${d.id}`}>{d.name}</Link>{d.gstin ? <div className="small muted">GSTIN {d.gstin}</div> : null}</td>
                  <td data-label="Contact">{d.contact_person ?? "—"}</td>
                  <td data-label="Phone">{maskPhone(d.normalized_phone)}</td>
                  <td data-label="Place">{[d.village, d.district].filter(Boolean).join(", ") || "—"}</td>
                  <td data-label="Map">{d.lat === null ? <span className="text-warn">Not found</span> : "✓ On map"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={page} hasMore={(list.data?.length ?? 0) > PAGE} onPage={setPage} />
      {creating ? <DistributorForm onClose={() => setCreating(false)} /> : null}
    </>
  );
}

export function DistributorForm({ onClose, distributor }: { onClose: () => void; distributor?: Distributor }) {
  const toast = useToast();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [f, setF] = useState(() => ({
    name: distributor?.name ?? "",
    contact_person: distributor?.contact_person ?? "",
    phone: distributor?.phone ?? "",
    alt_contact: distributor?.alt_contact ?? "",
    email: distributor?.email ?? "",
    gstin: distributor?.gstin ?? "",
    address: distributor?.address ?? "",
    village: distributor?.village ?? "",
    district: distributor?.district ?? "",
    state: distributor?.state ?? "",
    postcode: distributor?.postcode ?? "",
    notes: distributor?.notes ?? "",
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  const save = useMutation({
    mutationFn: async () => {
      const parsed = distributorInput.safeParse({ ...f, active: distributor?.active ?? true });
      if (!parsed.success) {
        setErrors(fieldErrors(parsed.error));
        throw new ApiError({ code: "validation", message: "Please fix the highlighted fields." });
      }
      setErrors({});
      const body = { ...parsed.data, email: parsed.data.email || null, gstin: parsed.data.gstin || null, phone: parsed.data.phone || null };
      const saved = distributor
        ? await must<Distributor>(supabase.from("distributors").update(body).eq("id", distributor.id).select().single())
        : await must<Distributor>(supabase.from("distributors").insert(body).select().single());
      // New distributor, changed address, or no pin yet: place the pin from the address automatically.
      const addrKey = (x: Partial<Distributor> | undefined) => [x?.address, x?.village, x?.district, x?.state, x?.postcode].map((v) => (v ?? "").trim()).join("|");
      let pinned: "set" | "not_found" | "skipped" = "skipped";
      if (!distributor || addrKey(distributor) !== addrKey(saved) || saved.lat === null) {
        try {
          const hit = await geocodeFarmerAddress(saved);
          if (hit) {
            await rpc("verify_distributor_location", { p_distributor: saved.id, p_lat: hit.lat, p_lon: hit.lon, p_source: hit.source });
            pinned = "set";
          } else pinned = "not_found";
        } catch {
          pinned = "not_found";
        }
      }
      return { row: saved, pinned };
    },
    onSuccess: ({ row, pinned }) => {
      qc.invalidateQueries({ queryKey: ["distributors"] });
      qc.invalidateQueries({ queryKey: ["distributor", row.id] });
      toast(
        pinned === "not_found" ? "info" : "ok",
        `${distributor ? "Distributor updated." : "Distributor added."}${pinned === "set" ? " Map location set from the address." : pinned === "not_found" ? " Couldn't find this address on the map — add a landmark/PIN code or place the pin manually." : ""}`,
      );
      onClose();
      if (!distributor) nav(`/admin/distributors/${row.id}`);
    },
    onError: (e: ApiError) => toast("error", e.message),
  });

  return (
    <Modal title={distributor ? "Edit distributor" : "Add distributor"} open onClose={onClose} wide footer={<Button form="dist-form" type="submit" busy={save.isPending}>Save</Button>}>
      <form id="dist-form" className="form-grid" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <TextInput label="Business name" required value={f.name} onChange={set("name")} error={errors.name} />
        <TextInput label="Contact person" value={f.contact_person} onChange={set("contact_person")} />
        <TextInput label="Mobile number" inputMode="tel" value={f.phone} onChange={set("phone")} error={errors.phone} />
        <TextInput label="Alternate contact" value={f.alt_contact} onChange={set("alt_contact")} />
        <TextInput label="Email" type="email" value={f.email} onChange={set("email")} error={errors.email} />
        <TextInput label="GSTIN (optional)" value={f.gstin} onChange={set("gstin")} error={errors.gstin} />
        <div className="span-2">
          <TextArea label="Full address / landmark" value={f.address} onChange={set("address")} hint="The map location is found from this address automatically. A plus code (e.g. HPQR+65W) or landmark makes it exact." />
        </div>
        <TextInput label="Village / town" value={f.village} onChange={set("village")} />
        <TextInput label="District" value={f.district} onChange={set("district")} />
        <TextInput label="State" value={f.state} onChange={set("state")} />
        <TextInput label="PIN code" inputMode="numeric" value={f.postcode} onChange={set("postcode")} error={errors.postcode} hint="Used to make sure the map location is in the right area." />
        <div className="span-2"><TextArea label="Notes" value={f.notes} onChange={set("notes")} /></div>
      </form>
    </Modal>
  );
}
