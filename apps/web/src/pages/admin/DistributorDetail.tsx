import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatINR, formatInTz, fromMinor, googleDirectionsUrl, lineTotalMinor, reasonInput, utcToLocalInput, zonedToUtc, type Distributor } from "@kisanroute/shared";
import { supabase } from "../../lib/supabase";
import { must, rpc, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useIdempotencyKey } from "../../lib/hooks";
import { useActiveProducts } from "../../lib/data";
import { geocodeFarmerAddress } from "../../lib/googlePlaces";
import { useToast } from "../../ui/toast";
import { Section } from "../../ui/Layout";
import { Banner, Button, Empty, ErrorState, KV, Loading, Modal, PageHeader, Select, TextArea, TextInput } from "../../ui/ui";
import { MapView } from "../../map/MapView";
import { DistributorForm } from "./Distributors";

interface SupplyRow {
  id: string;
  supplied_at: string;
  status: "confirmed" | "void";
  total: string;
  reference: string | null;
  notes: string | null;
  void_reason: string | null;
  items: { id: string; product_name: string; product_sku: string; unit: string; quantity: string; unit_price: string; line_total: string }[];
}

export default function DistributorDetail() {
  const { id } = useParams();
  const { tz } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [supplying, setSupplying] = useState(false);
  const [candidate, setCandidate] = useState<{ lat: number; lon: number } | null>(null);

  const dist = useQuery({ queryKey: ["distributor", id], queryFn: () => must<Distributor>(supabase.from("distributors").select("*").eq("id", id!).single()) });
  const supplies = useQuery({
    queryKey: ["supplies", id],
    queryFn: () =>
      must<SupplyRow[]>(
        supabase
          .from("distributor_supplies")
          .select("id,supplied_at,status,total,reference,notes,void_reason,items:distributor_supply_items(id,product_name,product_sku,unit,quantity,unit_price,line_total)")
          .eq("distributor_id", id!)
          .order("supplied_at", { ascending: false })
          .limit(200),
      ),
  });

  const savePin = useMutation({
    mutationFn: (c: { lat: number; lon: number; source: string }) => rpc<Distributor>("verify_distributor_location", { p_distributor: id, p_lat: c.lat, p_lon: c.lon, p_source: c.source }),
    onSuccess: () => {
      setCandidate(null);
      qc.invalidateQueries({ queryKey: ["distributor", id] });
      qc.invalidateQueries({ queryKey: ["distributors"] });
      toast("ok", "Map location saved.");
    },
    onError: (e: ApiError) => toast("error", e.message),
  });
  const fromAddress = useMutation({
    mutationFn: async () => {
      const hit = await geocodeFarmerAddress(dist.data!);
      if (!hit) throw new ApiError({ code: "validation", message: "Couldn't find this address on the map. Add a landmark or PIN code, or place the pin manually." });
      await rpc("verify_distributor_location", { p_distributor: id, p_lat: hit.lat, p_lon: hit.lon, p_source: hit.source });
      return hit;
    },
    onSuccess: (hit) => {
      setCandidate(null);
      qc.invalidateQueries({ queryKey: ["distributor", id] });
      qc.invalidateQueries({ queryKey: ["distributors"] });
      toast("ok", `Map location set from the address (${hit.label}).`);
    },
    onError: (e: ApiError) => toast("error", e.message),
  });
  // No location yet: find it from the address when the page opens.
  const autoTried = useRef(false);
  useEffect(() => {
    const d = dist.data;
    if (!d || autoTried.current || d.lat !== null || !(d.address || d.village)) return;
    autoTried.current = true;
    fromAddress.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dist.data]);
  const archive = useMutation({
    mutationFn: (active: boolean) => must(supabase.from("distributors").update({ active }).eq("id", id!)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["distributor", id] }),
    onError: (e: ApiError) => toast("error", e.message),
  });

  const totals = useMemo(() => {
    const ok = (supplies.data ?? []).filter((s) => s.status === "confirmed");
    return { count: ok.length, amount: ok.reduce((sum, s) => sum + Number(s.total), 0), last: ok[0]?.supplied_at ?? null };
  }, [supplies.data]);

  if (dist.isLoading) return <Loading />;
  if (dist.error) return <ErrorState error={dist.error} onRetry={() => dist.refetch()} />;
  const d = dist.data!;
  const pin = candidate ?? (d.lat !== null ? { lat: d.lat, lon: d.lon! } : null);
  const addr = [d.address, d.village, d.district, d.state, d.postcode].filter(Boolean).join(", ");

  return (
    <>
      <PageHeader
        title={d.name}
        sub={<>{[d.village, d.district].filter(Boolean).join(", ") || "Distributor"}{d.active ? "" : " · Archived"}</>}
        actions={
          <>
            <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
            <Button onClick={() => setSupplying(true)} disabled={!d.active}>+ Supply products</Button>
            <Button variant="ghost" onClick={() => archive.mutate(!d.active)} busy={archive.isPending}>{d.active ? "Archive" : "Restore"}</Button>
          </>
        }
      />
      <div className="grid-2">
        <Section title="Contact & address">
          <KV
            items={[
              ["Contact person", d.contact_person],
              ["Phone", d.phone ? <a key="p" href={`tel:${d.normalized_phone ?? d.phone}`}>{d.normalized_phone ?? d.phone}</a> : "—"],
              ["Alternate", d.alt_contact],
              ["Email", d.email ? <a key="e" href={`mailto:${d.email}`}>{d.email}</a> : "—"],
              ["GSTIN", d.gstin],
              ["Address", addr || "—"],
              ["Notes", d.notes],
              ["Supplies", `${totals.count} · ${formatINR(totals.amount)}`],
              ["Last supply", totals.last ? formatInTz(totals.last, tz) : "None"],
            ]}
          />
        </Section>
        <Section title="Location">
          <p className="small">
            {candidate ? <strong className="text-warn">New pin placed — press Save location.</strong>
              : d.lat === null ? <span className="text-warn">Location not found yet.</span>
              : `✓ ${d.geocode_source?.startsWith("google") ? "Found from the address" : "Set on the map"}${d.location_confirmed_at ? ` · ${formatInTz(d.location_confirmed_at, tz)}` : ""}`}
          </p>
          <MapView
            height={300}
            title="Distributor location"
            center={pin ? [pin.lat, pin.lon] : null}
            zoom={17}
            markers={pin ? [{ id: "d", lat: pin.lat, lon: pin.lon, label: d.name, kind: candidate ? "pick" : "farmer" }] : []}
            onPick={(lat, lon) => setCandidate({ lat, lon })}
          />
          <div className="row">
            <Button onClick={() => fromAddress.mutate()} busy={fromAddress.isPending}>📍 Set from address</Button>
            {pin && !candidate ? <a className="btn btn-secondary" href={googleDirectionsUrl(pin)} target="_blank" rel="noopener noreferrer">🧭 Directions</a> : null}
            {candidate ? (
              <>
                <Button onClick={() => savePin.mutate({ ...candidate, source: "admin_pin" })} busy={savePin.isPending}>Save location</Button>
                <Button variant="ghost" onClick={() => setCandidate(null)}>Discard</Button>
              </>
            ) : null}
          </div>
          <p className="small muted">The location comes from the address automatically. To correct it, click the exact spot on the map and press Save location.</p>
        </Section>
      </div>
      <Section title="Supply history">
        {supplies.isLoading ? <Loading /> : supplies.error ? <ErrorState error={supplies.error} /> : !supplies.data?.length ? <Empty title="No supplies recorded yet" /> : (
          <ul className="list">{supplies.data.map((s) => <SupplyItem key={s.id} s={s} distributorId={d.id} />)}</ul>
        )}
      </Section>
      {editing ? <DistributorForm distributor={d} onClose={() => setEditing(false)} /> : null}
      {supplying ? <SupplyForm distributorId={d.id} onClose={() => setSupplying(false)} /> : null}
    </>
  );
}

function SupplyItem({ s, distributorId }: { s: SupplyRow; distributorId: string }) {
  const { tz } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => {
      const r = reasonInput.safeParse(reason);
      if (!r.success) throw new ApiError({ code: "validation", message: r.error.issues[0]!.message });
      return rpc("admin_void_supply", { p_supply: s.id, p_reason: r.data });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["supplies", distributorId] }); setVoiding(false); toast("ok", "Supply voided (kept in audit history)."); },
    onError: (e: ApiError) => toast("error", e.message),
  });
  return (
    <li className={`list-item ${s.status === "void" ? "voided" : ""}`}>
      <div>
        <strong>{formatInTz(s.supplied_at, tz)} · {formatINR(s.total)}</strong> {s.status === "void" ? <span className="badge badge-cancelled">Void: {s.void_reason}</span> : null}
        {s.reference ? <span className="muted small"> · Ref {s.reference}</span> : null}
        <ul className="small">
          {s.items.map((i) => <li key={i.id}>{i.product_name} ({i.product_sku}) — {Number(i.quantity)} {i.unit} × {formatINR(i.unit_price)} = {formatINR(i.line_total)}</li>)}
        </ul>
        {s.notes ? <p className="small muted">{s.notes}</p> : null}
      </div>
      {s.status === "confirmed" ? <Button variant="ghost" className="btn-sm" onClick={() => setVoiding(true)}>Void</Button> : null}
      {voiding ? (
        <Modal title="Void supply" open onClose={() => setVoiding(false)} footer={<Button variant="danger" busy={m.isPending} onClick={() => m.mutate()}>Void supply</Button>}>
          <p>Voided supplies stay in the record for audit and are excluded from totals.</p>
          <TextArea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} />
        </Modal>
      ) : null}
    </li>
  );
}

function SupplyForm({ distributorId, onClose }: { distributorId: string; onClose: () => void }) {
  const { tz } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const products = useActiveProducts();
  const [key, resetKey] = useIdempotencyKey();
  const [when, setWhen] = useState(utcToLocalInput(new Date().toISOString(), tz));
  const [ref, setRef] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<{ product_id: string; quantity: string; unit_price: string }[]>([{ product_id: "", quantity: "1", unit_price: "" }]);
  const [err, setErr] = useState<string | null>(null);

  const priceOf = (pid: string) => products.data?.find((p) => p.id === pid)?.price ?? null;
  let totalMinor = 0;
  let totalOk = true;
  for (const i of items) {
    try {
      const price = i.unit_price || priceOf(i.product_id);
      if (!i.product_id || !price) { totalOk = false; continue; }
      totalMinor += lineTotalMinor(i.quantity, price);
    } catch { totalOk = false; }
  }

  const save = useMutation({
    mutationFn: async () => {
      if (items.some((i) => !i.product_id)) throw new ApiError({ code: "validation", message: "Choose a product on every line." });
      if (items.some((i) => !/^\d{1,9}(\.\d{1,3})?$/.test(i.quantity.trim()) || Number(i.quantity) <= 0)) throw new ApiError({ code: "validation", message: "Enter a quantity greater than 0 on every line." });
      if (items.some((i) => i.unit_price && !/^\d{1,10}(\.\d{1,2})?$/.test(i.unit_price.trim()))) throw new ApiError({ code: "validation", message: "Unit price like 1250 or 1250.50." });
      return rpc<{ supply_id: string; total: string; replayed: boolean }>("admin_create_supply", {
        p_distributor: distributorId,
        p_supplied_at: zonedToUtc(when, tz).toISOString(),
        p_items: items.map((i) => ({ product_id: i.product_id, quantity: i.quantity.trim(), unit_price: i.unit_price.trim() || null })),
        p_idempotency_key: key,
        p_reference: ref || null,
        p_notes: notes || null,
      });
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["supplies", distributorId] });
      toast("ok", r.replayed ? "This supply was already saved." : `Supply saved: ${formatINR(r.total)}`);
      resetKey();
      onClose();
    },
    onError: (e: ApiError) => setErr(e.message),
  });

  return (
    <Modal title="Supply products" open onClose={onClose} wide footer={<Button busy={save.isPending} onClick={() => save.mutate()}>Save supply</Button>}>
      {err ? <Banner kind="error">{err}</Banner> : null}
      <div className="form-grid">
        <TextInput label={`Date & time (${tz})`} type="datetime-local" required value={when} onChange={(e) => setWhen(e.target.value)} />
        <TextInput label="Invoice / challan no. (optional)" value={ref} onChange={(e) => setRef(e.target.value)} />
      </div>
      <h3 className="h3">Products</h3>
      {items.map((it, idx) => {
        const listPrice = priceOf(it.product_id);
        return (
          <div key={idx} className="line-item">
            <Select label="Product" value={it.product_id} onChange={(e) => setItems(items.map((x, i) => (i === idx ? { ...x, product_id: e.target.value } : x)))}>
              <option value="">Choose…</option>
              {products.data?.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.unit}){p.price ? ` — ${formatINR(p.price)}` : ""}</option>)}
            </Select>
            <TextInput label="Quantity" inputMode="decimal" value={it.quantity} onChange={(e) => setItems(items.map((x, i) => (i === idx ? { ...x, quantity: e.target.value } : x)))} />
            <TextInput label="Unit price ₹" inputMode="decimal" placeholder={listPrice ?? "required"} hint={listPrice ? "Blank = catalog price" : "No catalog price"} value={it.unit_price} onChange={(e) => setItems(items.map((x, i) => (i === idx ? { ...x, unit_price: e.target.value } : x)))} />
            <Button variant="ghost" aria-label="Remove line" disabled={items.length === 1} onClick={() => setItems(items.filter((_, i) => i !== idx))}>✕</Button>
          </div>
        );
      })}
      <Button variant="secondary" onClick={() => setItems([...items, { product_id: "", quantity: "1", unit_price: "" }])}>+ Add product</Button>
      <p className="total">Estimated total: <strong>{totalOk ? formatINR(fromMinor(totalMinor)) : "—"}</strong> <span className="muted small">(final amount is calculated by the server)</span></p>
      <TextArea label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
    </Modal>
  );
}
