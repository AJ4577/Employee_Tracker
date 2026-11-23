import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { farmerInput, fieldErrors, maskPhone, type Farmer } from "@kisanroute/shared";
import { supabase } from "../../lib/supabase";
import { must, rpc, ApiError } from "../../lib/api";
import { geocodeFarmerAddress } from "../../lib/googlePlaces";
import { useDebounced } from "../../lib/hooks";
import { ilikeSafe, useActiveProducts } from "../../lib/data";
import { useToast } from "../../ui/toast";
import { Banner, Button, Empty, ErrorState, Loading, Modal, PageHeader, Pager, Select, TextArea, TextInput } from "../../ui/ui";

const PAGE = 25;

export default function Farmers() {
  const [q, setQ] = useState("");
  const [crop, setCrop] = useState("");
  const [product, setProduct] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const dq = useDebounced(q);
  const products = useActiveProducts();

  const list = useQuery({
    queryKey: ["farmers", dq, crop, product, showArchived, page],
    queryFn: async () => {
      let ids: string[] | null = null;
      if (product) {
        const items = await must<{ purchase: { farmer_id: string } | null }[]>(
          supabase.from("purchase_items").select("purchase:purchases!inner(farmer_id,status)").eq("product_id", product).eq("purchase.status", "confirmed").limit(5000),
        );
        ids = [...new Set(items.map((i) => i.purchase?.farmer_id).filter(Boolean) as string[])];
        if (!ids.length) return [];
      }
      let qb = supabase.from("farmers").select("*").eq("active", !showArchived).order("name").range(page * PAGE, page * PAGE + PAGE);
      const t = ilikeSafe(dq);
      if (t) {
        const digits = t.replace(/\D/g, "");
        qb = qb.or([`name.ilike.*${t}*`, `village.ilike.*${t}*`, digits.length >= 4 ? `normalized_phone.ilike.*${digits}*` : null].filter(Boolean).join(","));
      }
      if (crop.trim()) qb = qb.contains("crops", [crop.trim().toLowerCase()]);
      if (ids) qb = qb.in("id", ids.slice(0, 500));
      return must<Farmer[]>(qb);
    },
  });
  const rows = list.data?.slice(0, PAGE) ?? [];

  return (
    <>
      <PageHeader title="Farmers" actions={<Button onClick={() => setCreating(true)}>+ Add farmer</Button>} />
      <div className="filters">
        <TextInput label="Search" type="search" placeholder="Name, village or phone" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
        <TextInput label="Crop" placeholder="e.g. soybean" value={crop} onChange={(e) => { setCrop(e.target.value); setPage(0); }} />
        <Select label="Purchased product" value={product} onChange={(e) => { setProduct(e.target.value); setPage(0); }}>
          <option value="">Any</option>
          {products.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <label className="check-inline">
          <input type="checkbox" checked={showArchived} onChange={(e) => { setShowArchived(e.target.checked); setPage(0); }} /> Show archived
        </label>
      </div>
      {list.isLoading ? <Loading /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !rows.length ? <Empty title="No farmers found" /> : (
        <div className="table-wrap">
          <table className="table cards-on-mobile">
            <thead>
              <tr><th>Name</th><th>Village</th><th>Phone</th><th>Crops</th><th>Map pin</th></tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id}>
                  <td data-label="Name"><Link to={`/admin/farmers/${f.id}`}>{f.name}</Link></td>
                  <td data-label="Village">{f.village ?? "—"}{f.district ? <span className="muted">, {f.district}</span> : null}</td>
                  <td data-label="Phone">{maskPhone(f.normalized_phone)}</td>
                  <td data-label="Crops">{f.crops.join(", ") || "—"}</td>
                  <td data-label="Map pin">{f.lat === null ? <span className="text-warn">Not set</span> : f.location_verified ? "✓ Confirmed" : <span className="text-warn">Approximate</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={page} hasMore={(list.data?.length ?? 0) > PAGE} onPage={setPage} />
      <FarmerForm open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

export function FarmerForm({ open, onClose, farmer }: { open: boolean; onClose: () => void; farmer?: Farmer }) {
  const toast = useToast();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [f, setF] = useState(() => ({
    name: farmer?.name ?? "",
    phone: farmer?.phone ?? "",
    alt_contact: farmer?.alt_contact ?? "",
    village: farmer?.village ?? "",
    district: farmer?.district ?? "",
    state: farmer?.state ?? "",
    postcode: farmer?.postcode ?? "",
    address: farmer?.address ?? "",
    crops: farmer?.crops.join(", ") ?? "",
    notes: farmer?.notes ?? "",
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dups, setDups] = useState<{ id: string; name: string; village: string | null; match: string }[] | null>(null);
  const [confirmedDup, setConfirmedDup] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  const save = useMutation({
    mutationFn: async (skipDupCheck: boolean) => {
      const parsed = farmerInput.safeParse({ ...f, crops: f.crops.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean), active: farmer?.active ?? true });
      if (!parsed.success) {
        setErrors(fieldErrors(parsed.error));
        throw new ApiError({ code: "validation", message: "Please fix the highlighted fields." });
      }
      setErrors({});
      if (!skipDupCheck && (parsed.data.phone || parsed.data.name)) {
        const d = await rpc<{ id: string; name: string; village: string | null; match: string }[]>("find_farmer_duplicates", { p_phone: parsed.data.phone ?? null, p_name: parsed.data.name, p_exclude: farmer?.id ?? null });
        if (d.length) {
          setDups(d);
          return null;
        }
      }
      const saved = farmer
        ? await must<Farmer>(supabase.from("farmers").update(parsed.data).eq("id", farmer.id).select().single())
        : await must<Farmer>(supabase.from("farmers").insert(parsed.data).select().single());
      // New farmer, changed address, or no pin yet: put the pin on the address automatically.
      const addrKey = (x: Partial<Farmer> | undefined) => [x?.address, x?.village, x?.district, x?.state, x?.postcode].map((v) => (v ?? "").trim()).join("|");
      let pinned: "set" | "not_found" | "skipped" = "skipped";
      if (!farmer || addrKey(farmer) !== addrKey(saved) || saved.lat === null) {
        try {
          const hit = await geocodeFarmerAddress(saved);
          if (hit) {
            await rpc("verify_farmer_location", { p_farmer: saved.id, p_lat: hit.lat, p_lon: hit.lon, p_source: hit.source });
            pinned = "set";
          } else pinned = "not_found";
        } catch {
          pinned = "not_found";
        }
      }
      return { row: saved, pinned };
    },
    onSuccess: (res) => {
      if (!res) return;
      const row = res.row;
      qc.invalidateQueries({ queryKey: ["farmers"] });
      qc.invalidateQueries({ queryKey: ["farmer", row.id] });
      qc.invalidateQueries({ queryKey: ["farmer-options"] });
      toast(
        res.pinned === "not_found" ? "info" : "ok",
        `${farmer ? "Farmer updated." : "Farmer added."}${res.pinned === "set" ? " Map pin set from the address." : res.pinned === "not_found" ? " Couldn't find this address on the map — add a landmark/PIN code or set the pin manually." : ""}`,
      );
      onClose();
      if (!farmer) nav(`/admin/farmers/${row.id}`);
    },
    onError: (e: ApiError) => toast("error", e.message),
  });

  return (
    <Modal title={farmer ? "Edit farmer" : "Add farmer"} open={open} onClose={onClose} wide footer={<Button form="farmer-form" type="submit" busy={save.isPending}>{dups && !confirmedDup ? "Save anyway" : "Save"}</Button>}>
      {dups && !confirmedDup ? (
        <Banner kind="warn">
          Possible duplicate{dups.length > 1 ? "s" : ""} found (not merged automatically):
          <ul>{dups.map((d) => <li key={d.id}><Link to={`/admin/farmers/${d.id}`} target="_blank">{d.name}</Link>{d.village ? ` — ${d.village}` : ""} (same {d.match})</li>)}</ul>
          <Button variant="secondary" className="btn-sm" onClick={() => setConfirmedDup(true)}>This is a different farmer</Button>
        </Banner>
      ) : null}
      <form id="farmer-form" className="form-grid" onSubmit={(e: FormEvent) => { e.preventDefault(); const skip = confirmedDup || !!dups; setConfirmedDup(skip); save.mutate(skip); }}>
        <TextInput label="Full name" required value={f.name} onChange={set("name")} error={errors.name} />
        <TextInput label="Mobile number" inputMode="tel" value={f.phone} onChange={set("phone")} error={errors.phone} hint="10-digit Indian mobile; stored as +91…" />
        <TextInput label="Alternate contact" value={f.alt_contact} onChange={set("alt_contact")} />
        <TextInput label="Village" value={f.village} onChange={set("village")} />
        <TextInput label="District" value={f.district} onChange={set("district")} />
        <TextInput label="State" value={f.state} onChange={set("state")} />
        <TextInput label="PIN code" inputMode="numeric" value={f.postcode} onChange={set("postcode")} error={errors.postcode} />
        <TextInput label="Crops (comma separated)" value={f.crops} onChange={set("crops")} />
        <div className="span-2"><TextArea label="Full address / landmark" value={f.address} onChange={set("address")} /></div>
        <div className="span-2"><TextArea label="Notes" value={f.notes} onChange={set("notes")} /></div>
      </form>
    </Modal>
  );
}
