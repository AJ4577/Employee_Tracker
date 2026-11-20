import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fieldErrors, formatINR, productInput, type Product } from "@kisanroute/shared";
import { supabase } from "../../lib/supabase";
import { must, ApiError } from "../../lib/api";
import { useDebounced } from "../../lib/hooks";
import { ilikeSafe } from "../../lib/data";
import { useToast } from "../../ui/toast";
import { Button, Empty, ErrorState, Loading, Modal, PageHeader, Pager, Select, TextArea, TextInput } from "../../ui/ui";

const PAGE = 25;

export default function Products() {
  const [q, setQ] = useState("");
  const [active, setActive] = useState("true");
  const [page, setPage] = useState(0);
  const [edit, setEdit] = useState<Product | "new" | null>(null);
  const dq = useDebounced(q);
  const list = useQuery({
    queryKey: ["products", dq, active, page],
    queryFn: () => {
      let qb = supabase.from("products").select("*").order("name").range(page * PAGE, page * PAGE + PAGE);
      if (active) qb = qb.eq("active", active === "true");
      const t = ilikeSafe(dq);
      if (t) qb = qb.or(`name.ilike.*${t}*,sku.ilike.*${t}*,category.ilike.*${t}*`);
      return must<Product[]>(qb);
    },
  });
  const rows = list.data?.slice(0, PAGE) ?? [];
  return (
    <>
      <PageHeader title="Products" sub="Catalog only — stock/warehouse quantities are not tracked." actions={<Button onClick={() => setEdit("new")}>+ Add product</Button>} />
      <div className="filters">
        <TextInput label="Search" type="search" placeholder="Name, SKU or category" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
        <Select label="Status" value={active} onChange={(e) => { setActive(e.target.value); setPage(0); }}>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
          <option value="">All</option>
        </Select>
      </div>
      {list.isLoading ? <Loading /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !rows.length ? <Empty title="No products" /> : (
        <div className="table-wrap">
          <table className="table cards-on-mobile">
            <thead><tr><th>SKU</th><th>Name</th><th>Category</th><th>Unit</th><th>Price</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td data-label="SKU"><code>{p.sku}</code></td>
                  <td data-label="Name">{p.name}</td>
                  <td data-label="Category">{p.category ?? "—"}</td>
                  <td data-label="Unit">{p.unit}</td>
                  <td data-label="Price">{formatINR(p.price)}</td>
                  <td data-label="Status">{p.active ? "Active" : "Inactive"}</td>
                  <td><Button variant="secondary" className="btn-sm" onClick={() => setEdit(p)}>Edit</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={page} hasMore={(list.data?.length ?? 0) > PAGE} onPage={setPage} />
      {edit ? <ProductForm product={edit === "new" ? undefined : edit} onClose={() => setEdit(null)} /> : null}
    </>
  );
}

function ProductForm({ product, onClose }: { product?: Product; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({
    sku: product?.sku ?? "", name: product?.name ?? "", category: product?.category ?? "", unit: product?.unit ?? "", description: product?.description ?? "",
    price: product?.price ?? "", active: product?.active ?? true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: async () => {
      const parsed = productInput.safeParse({ ...f, price: f.price === "" ? null : String(f.price) });
      if (!parsed.success) { setErrors(fieldErrors(parsed.error)); throw new ApiError({ code: "validation", message: "Please fix the highlighted fields." }); }
      setErrors({});
      const body = { ...parsed.data, price: parsed.data.price ?? null };
      const r = product ? await supabase.from("products").update(body).eq("id", product.id) : await supabase.from("products").insert(body);
      if (r.error?.code === "23505") { setErrors({ sku: "This SKU already exists" }); throw new ApiError({ code: "validation", message: "SKU must be unique." }); }
      if (r.error) throw new ApiError({ code: "unknown", message: r.error.message });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["products"] }); qc.invalidateQueries({ queryKey: ["products-active"] }); toast("ok", "Product saved."); onClose(); },
    onError: (e: ApiError) => toast("error", e.message),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Modal title={product ? "Edit product" : "Add product"} open onClose={onClose} footer={<Button form="pf" type="submit" busy={save.isPending}>Save</Button>}>
      <form id="pf" className="form-grid" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <TextInput label="SKU / code" required value={f.sku} onChange={set("sku")} error={errors.sku} />
        <TextInput label="Name" required value={f.name} onChange={set("name")} error={errors.name} />
        <TextInput label="Category" value={f.category} onChange={set("category")} />
        <TextInput label="Pack / unit" required placeholder="kg, bag 30 kg, litre…" value={f.unit} onChange={set("unit")} error={errors.unit} />
        <TextInput label="Price ₹ (optional)" inputMode="decimal" value={f.price ?? ""} onChange={set("price")} error={errors.price} />
        <Select label="Status" value={f.active ? "1" : "0"} onChange={(e) => setF((x) => ({ ...x, active: e.target.value === "1" }))}>
          <option value="1">Active</option>
          <option value="0">Inactive</option>
        </Select>
        <div className="span-2"><TextArea label="Description" value={f.description} onChange={set("description")} /></div>
      </form>
    </Modal>
  );
}
