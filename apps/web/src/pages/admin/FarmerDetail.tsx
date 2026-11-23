import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  distanceMeters,
  fieldErrors,
  formatINR,
  formatInTz,
  fromMinor,
  lineTotalMinor,
  purchaseInput,
  reasonInput,
  TASK_TYPE_LABEL,
  utcToLocalInput,
  zonedToUtc,
  type Farmer,
  type Visit,
} from "@kisanroute/shared";
import { supabase } from "../../lib/supabase";
import { geocodeFarmerAddress } from "../../lib/googlePlaces";
import { must, rpc, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { getBrowserFix, useIdempotencyKey } from "../../lib/hooks";
import { useActiveProducts } from "../../lib/data";
import { useToast } from "../../ui/toast";
import { Section } from "../../ui/Layout";
import { Banner, Button, Empty, ErrorState, KV, Loading, Modal, PageHeader, Select, StatusBadge, TextArea, TextInput } from "../../ui/ui";
import { MapView } from "../../map/MapView";
import { FarmerForm } from "./Farmers";
import { VisitForm } from "./Visits";

interface PurchaseRow {
  id: string;
  purchased_at: string;
  status: "confirmed" | "void";
  total: string;
  external_reference: string | null;
  notes: string | null;
  void_reason: string | null;
  items: { id: string; product_name: string; product_sku: string; unit: string; quantity: string; unit_price: string; line_total: string }[];
}

export default function FarmerDetail() {
  const { id } = useParams();
  const { tz } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [buying, setBuying] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [candidate, setCandidate] = useState<{ lat: number; lon: number; source: string } | null>(null);

  const farmer = useQuery({ queryKey: ["farmer", id], queryFn: () => must<Farmer>(supabase.from("farmers").select("*").eq("id", id!).single()) });
  const purchases = useQuery({
    queryKey: ["purchases", id],
    queryFn: () => must<PurchaseRow[]>(supabase.from("purchases").select("id,purchased_at,status,total,external_reference,notes,void_reason,items:purchase_items(id,product_name,product_sku,unit,quantity,unit_price,line_total)").eq("farmer_id", id!).order("purchased_at", { ascending: false }).limit(200)),
  });
  const visits = useQuery({
    queryKey: ["farmer-visits", id],
    queryFn: () => must<(Visit & { staff: { display_name: string } | null })[]>(supabase.from("visits").select("*, staff:profiles(display_name)").eq("farmer_id", id!).order("scheduled_at", { ascending: false }).limit(100)),
  });

  // Sanity check before confirming: where does Google place the farmer's address? A pin many km away
  // is almost always a mistake (e.g. a pin dropped in another city).
  const confirmPin = async (c: { lat: number; lon: number; source: string }) => {
    const fd = farmer.data;
    const addr = [fd?.address, fd?.village, fd?.district, fd?.state, fd?.postcode].filter(Boolean).join(", ");
    const g = (window as unknown as { google?: { maps?: { importLibrary?: (n: string) => Promise<unknown> } } }).google;
    if (addr && g?.maps?.importLibrary) {
      try {
        const { Place } = (await g.maps.importLibrary("places")) as google.maps.PlacesLibrary;
        const { places } = await Place.searchByText({ textQuery: addr, fields: ["location"], region: "in", maxResultCount: 1 });
        const loc = places[0]?.location;
        if (loc) {
          const km = distanceMeters({ lat: c.lat, lon: c.lon }, { lat: loc.lat(), lon: loc.lng() }) / 1000;
          if (km > 5 && !window.confirm(`This pin is about ${Math.round(km)} km away from the farmer's address (${fd?.village ?? fd?.district ?? "address"}).\n\nDirections for staff will go to the pin. Confirm this pin anyway?`)) return;
        }
      } catch {
        /* address check unavailable: confirm normally */
      }
    }
    verify.mutate(c);
  };

  const fromAddress = useMutation({
    mutationFn: async () => {
      const fd = farmer.data!;
      const hit = await geocodeFarmerAddress(fd);
      if (!hit) throw new ApiError({ code: "validation", message: "Couldn't find this address on the map. Add a landmark or PIN code to the address, or place the pin manually." });
      await rpc("verify_farmer_location", { p_farmer: fd.id, p_lat: hit.lat, p_lon: hit.lon, p_source: hit.source });
      return hit;
    },
    onSuccess: (hit) => {
      setCandidate(null);
      qc.invalidateQueries({ queryKey: ["farmer", id] });
      qc.invalidateQueries({ queryKey: ["farmer-options"] });
      toast("ok", `Map pin set from the address (${hit.label}). Open visits use it now.`);
    },
    onError: (e: ApiError) => toast("error", e.message),
  });
  // A farmer without a pin gets one from the address automatically when the page opens.
  const autoTried = useRef(false);
  useEffect(() => {
    const fd = farmer.data;
    if (!fd || autoTried.current || fd.lat !== null || !(fd.address || fd.village)) return;
    autoTried.current = true;
    fromAddress.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [farmer.data]);

  const verify = useMutation({
    mutationFn: (c: { lat: number; lon: number; source: string }) => rpc<Farmer>("verify_farmer_location", { p_farmer: id, p_lat: c.lat, p_lon: c.lon, p_source: c.source }),
    onSuccess: () => {
      setCandidate(null);
      qc.invalidateQueries({ queryKey: ["farmer", id] });
      qc.invalidateQueries({ queryKey: ["farmer-options"] });
      toast("ok", "Map pin confirmed. Open visits now use this location.");
    },
    onError: (e: ApiError) => toast("error", e.message),
  });
  const archive = useMutation({
    mutationFn: (active: boolean) => must(supabase.from("farmers").update({ active }).eq("id", id!)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["farmer", id] }),
    onError: (e: ApiError) => toast("error", e.message),
  });

  const lastPurchase = purchases.data?.find((p) => p.status === "confirmed");
  const productsBought = useMemo(() => {
    const m = new Map<string, { name: string; qty: number; unit: string }>();
    for (const p of purchases.data ?? []) if (p.status === "confirmed") for (const i of p.items) {
      const e = m.get(i.product_sku) ?? { name: i.product_name, qty: 0, unit: i.unit };
      e.qty += Number(i.quantity);
      m.set(i.product_sku, e);
    }
    return [...m.values()];
  }, [purchases.data]);

  if (farmer.isLoading) return <Loading />;
  if (farmer.error) return <ErrorState error={farmer.error} onRetry={() => farmer.refetch()} />;
  const f = farmer.data!;
  const pin = candidate ?? (f.lat !== null ? { lat: f.lat, lon: f.lon! } : null);

  return (
    <>
      <PageHeader
        title={f.name}
        sub={<>{f.village ?? "No village"}{f.active ? "" : " · Archived"}</>}
        actions={
          <>
            <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
            <Button variant="secondary" onClick={() => setBuying(true)} disabled={!f.active}>+ Purchase</Button>
            <Button onClick={() => setAssigning(true)} disabled={!f.active}>+ Assign visit</Button>
            <Button variant="ghost" onClick={() => archive.mutate(!f.active)} busy={archive.isPending}>{f.active ? "Archive" : "Restore"}</Button>
          </>
        }
      />
      <div className="grid-2">
        <Section title="Contact & address">
          <KV
            items={[
              ["Phone", f.phone ? <a key="p" href={`tel:${f.normalized_phone ?? f.phone}`}>{f.normalized_phone ?? f.phone}</a> : "—"],
              ["Alternate contact", f.alt_contact],
              ["Address", f.address],
              ["Village / District", [f.village, f.district].filter(Boolean).join(", ") || "—"],
              ["State / PIN", [f.state, f.postcode].filter(Boolean).join(" ") || "—"],
              ["Crops", f.crops.join(", ") || "—"],
              ["Notes", f.notes],
              ["Latest purchase", lastPurchase ? `${formatInTz(lastPurchase.purchased_at, tz)} · ${formatINR(lastPurchase.total)}` : "None"],
              ["Products bought", productsBought.map((p) => `${p.name} (${p.qty} ${p.unit})`).join(", ") || "—"],
            ]}
          />
        </Section>
        <Section title="Farm location">
          <p className="small">
            {candidate ? <strong className="text-warn">Unsaved pin — confirm to save.</strong> : f.lat === null ? <span className="text-warn">No pin yet.</span> : f.location_verified ? `✓ Confirmed ${f.location_confirmed_at ? formatInTz(f.location_confirmed_at, tz) : ""} (${f.geocode_source ?? "manual"})` : <span className="text-warn">Approximate — not confirmed</span>}
          </p>
          <MapView
            height={300}
            title="Farmer location"
            markers={pin ? [{ id: "pin", lat: pin.lat, lon: pin.lon, label: f.name, kind: candidate ? "pick" : f.location_verified ? "farmer" : "farmer-approx" }] : []}
            onPick={(lat, lon) => setCandidate({ lat, lon, source: "admin_pin" })}
            legend={<span className="small">Search to move the map, then <strong>click/tap the exact farm spot</strong> to place the pin. Searching never changes the saved pin.</span>}
          />
          <div className="row">
            <Button onClick={() => fromAddress.mutate()} busy={fromAddress.isPending}>📍 Set pin from address</Button>
            <Button variant="secondary" onClick={async () => { const fix = await getBrowserFix(); if (!fix) toast("error", "Couldn't get your location (permission denied or no GPS)."); else setCandidate({ lat: fix.lat, lon: fix.lon, source: `device_gps_${Math.round(fix.accuracy_m)}m` }); }}>
              Use my current location
            </Button>
            {candidate ? (
              <>
                <Button onClick={() => confirmPin(candidate)} busy={verify.isPending}>Confirm pin</Button>
                <Button variant="ghost" onClick={() => setCandidate(null)}>Discard</Button>
              </>
            ) : f.lat !== null && !f.location_verified ? (
              <Button onClick={() => confirmPin({ lat: f.lat!, lon: f.lon!, source: f.geocode_source ?? "admin_pin" })} busy={verify.isPending}>Confirm current pin</Button>
            ) : (
              <Button disabled title="Click the farm spot on the map first">Confirm pin</Button>
            )}
          </div>
          {!candidate ? (
            <p className="small muted">
              {f.lat === null ? "Step 1: click the exact farm spot on the map (or use “Set farm pin here” on a search result). Step 2: press Confirm pin." : "To change the pin: click the new farm spot on the map (or “Set farm pin here” on a search result), then press Confirm pin."}
            </p>
          ) : (
            <p className="small"><strong>New pin placed.</strong> Press <strong>Confirm pin</strong> to save it.</p>
          )}
        </Section>
      </div>
      <Section title="Purchase history">
        {purchases.isLoading ? <Loading /> : purchases.error ? <ErrorState error={purchases.error} /> : !purchases.data?.length ? <Empty title="No purchases recorded" /> : (
          <ul className="list">
            {purchases.data.map((p) => <PurchaseItem key={p.id} p={p} farmerId={f.id} />)}
          </ul>
        )}
      </Section>
      <Section title="Visit history">
        {visits.isLoading ? <Loading /> : !visits.data?.length ? <Empty title="No visits yet" /> : (
          <ul className="list compact">
            {visits.data.map((v) => (
              <li key={v.id} className="list-item">
                <Link to={`/admin/visits/${v.id}`}>{formatInTz(v.scheduled_at, v.timezone)} · {TASK_TYPE_LABEL[v.type]} · {v.staff?.display_name}</Link>
                <StatusBadge status={v.status} />
              </li>
            ))}
          </ul>
        )}
      </Section>
      {editing ? <FarmerForm open onClose={() => setEditing(false)} farmer={f} /> : null}
      {buying ? <PurchaseForm farmerId={f.id} onClose={() => setBuying(false)} /> : null}
      {assigning ? <VisitForm open presetFarmer={f.id} onClose={() => setAssigning(false)} /> : null}
    </>
  );
}

function PurchaseItem({ p, farmerId }: { p: PurchaseRow; farmerId: string }) {
  const { tz } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => {
      const r = reasonInput.safeParse(reason);
      if (!r.success) throw new ApiError({ code: "validation", message: r.error.issues[0]!.message });
      return rpc("admin_void_purchase", { p_purchase: p.id, p_reason: r.data });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["purchases", farmerId] }); setVoiding(false); toast("ok", "Purchase voided (kept in audit history)."); },
    onError: (e: ApiError) => toast("error", e.message),
  });
  return (
    <li className={`list-item ${p.status === "void" ? "voided" : ""}`}>
      <div>
        <strong>{formatInTz(p.purchased_at, tz)} · {formatINR(p.total)}</strong> {p.status === "void" ? <span className="badge badge-cancelled">Void: {p.void_reason}</span> : null}
        {p.external_reference ? <span className="muted small"> · Ref {p.external_reference}</span> : null}
        <ul className="small">
          {p.items.map((i) => <li key={i.id}>{i.product_name} ({i.product_sku}) — {Number(i.quantity)} {i.unit} × {formatINR(i.unit_price)} = {formatINR(i.line_total)}</li>)}
        </ul>
        {p.notes ? <p className="small muted">{p.notes}</p> : null}
      </div>
      {p.status === "confirmed" ? <Button variant="ghost" className="btn-sm" onClick={() => setVoiding(true)}>Void</Button> : null}
      {voiding ? (
        <Modal title="Void purchase" open onClose={() => setVoiding(false)} footer={<Button variant="danger" busy={m.isPending} onClick={() => m.mutate()}>Void purchase</Button>}>
          <p>Voided purchases stay in the record for audit and are excluded from totals.</p>
          <TextArea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} />
        </Modal>
      ) : null}
    </li>
  );
}

function PurchaseForm({ farmerId, onClose }: { farmerId: string; onClose: () => void }) {
  const { tz } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const products = useActiveProducts();
  const [key, resetKey] = useIdempotencyKey();
  const [when, setWhen] = useState(utcToLocalInput(new Date().toISOString(), tz));
  const [ref, setRef] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<{ product_id: string; quantity: string; unit_price: string }[]>([{ product_id: "", quantity: "1", unit_price: "" }]);
  const [errors, setErrors] = useState<Record<string, string>>({});

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
      const parsed = purchaseInput.safeParse({
        farmer_id: farmerId,
        purchased_at: zonedToUtc(when, tz).toISOString(),
        items: items.map((i) => ({ product_id: i.product_id, quantity: i.quantity, unit_price: i.unit_price || null })),
        external_reference: ref,
        notes,
      });
      if (!parsed.success) { setErrors(fieldErrors(parsed.error)); throw new ApiError({ code: "validation", message: "Please fix the highlighted fields." }); }
      setErrors({});
      return rpc<{ purchase_id: string; total: string; replayed: boolean }>("admin_create_purchase", {
        p_farmer: farmerId, p_purchased_at: parsed.data.purchased_at, p_items: parsed.data.items, p_idempotency_key: key, p_external_reference: parsed.data.external_reference, p_notes: parsed.data.notes,
      });
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["purchases", farmerId] });
      toast("ok", r.replayed ? "Purchase was already saved." : `Purchase saved: ${formatINR(r.total)}`);
      resetKey();
      onClose();
    },
    onError: (e: ApiError) => toast("error", e.message),
  });

  return (
    <Modal title="Record purchase" open onClose={onClose} wide footer={<Button busy={save.isPending} onClick={() => save.mutate()}>Save purchase</Button>}>
      <div className="form-grid">
        <TextInput label={`Purchase date & time (${tz})`} type="datetime-local" required value={when} onChange={(e) => setWhen(e.target.value)} error={errors.purchased_at} />
        <TextInput label="Order / invoice reference (optional)" value={ref} onChange={(e) => setRef(e.target.value)} />
      </div>
      <h3 className="h3">Line items</h3>
      {errors.items ? <Banner kind="error">{errors.items}</Banner> : null}
      {items.map((it, idx) => {
        const listPrice = priceOf(it.product_id);
        return (
          <div key={idx} className="line-item">
            <Select label="Product" value={it.product_id} error={errors[`items.${idx}.product_id`]} onChange={(e) => setItems(items.map((x, i) => (i === idx ? { ...x, product_id: e.target.value } : x)))}>
              <option value="">Choose…</option>
              {products.data?.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.unit}){p.price ? ` — ${formatINR(p.price)}` : ""}</option>)}
            </Select>
            <TextInput label="Quantity" inputMode="decimal" value={it.quantity} error={errors[`items.${idx}.quantity`]} onChange={(e) => setItems(items.map((x, i) => (i === idx ? { ...x, quantity: e.target.value } : x)))} />
            <TextInput label="Unit price ₹" inputMode="decimal" placeholder={listPrice ?? "required"} hint={listPrice ? "Blank = catalog price" : "No catalog price"} value={it.unit_price} error={errors[`items.${idx}.unit_price`]} onChange={(e) => setItems(items.map((x, i) => (i === idx ? { ...x, unit_price: e.target.value } : x)))} />
            <Button variant="ghost" aria-label="Remove line" disabled={items.length === 1} onClick={() => setItems(items.filter((_, i) => i !== idx))}>✕</Button>
          </div>
        );
      })}
      <Button variant="secondary" onClick={() => setItems([...items, { product_id: "", quantity: "1", unit_price: "" }])}>+ Add line</Button>
      <p className="total">Estimated total: <strong>{totalOk ? formatINR(fromMinor(totalMinor)) : "—"}</strong> <span className="muted small">(final amount is calculated by the server)</span></p>
      <TextArea label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
    </Modal>
  );
}
