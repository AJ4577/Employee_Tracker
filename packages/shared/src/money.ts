/**
 * Currency math in integer minor units (paise) to avoid floating-point drift.
 * The database stores numeric(12,2)/numeric(14,2) and recomputes totals server-side;
 * these helpers are for client previews only.
 */
export function toMinor(value: string | number): number {
  const s = typeof value === "number" ? value.toFixed(2) : value.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Invalid amount: ${value}`);
  const neg = s.startsWith("-");
  const [whole = "0", frac = ""] = s.replace("-", "").split(".");
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return neg ? -minor : minor;
}

export function fromMinor(minor: number): string {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  return `${neg ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** quantity may have up to 3 decimals (e.g. 2.5 kg). Result rounded half-up to paise. */
export function lineTotalMinor(quantity: string | number, unitPrice: string | number): number {
  const q = typeof quantity === "number" ? quantity.toString() : quantity.trim();
  if (!/^\d+(\.\d{1,3})?$/.test(q)) throw new Error(`Invalid quantity: ${quantity}`);
  const [w = "0", f = ""] = q.split(".");
  const qMilli = Number(w) * 1000 + Number(f.padEnd(3, "0"));
  const raw = qMilli * toMinor(unitPrice); // minor * 1000
  return Math.floor((raw + 500) / 1000);
}

export function formatINR(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "number" ? value : Number(value);
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n);
}
