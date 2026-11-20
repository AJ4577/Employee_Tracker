/** Normalise an Indian mobile number to E.164 (+91XXXXXXXXXX). Returns null if not plausible. */
export function normalizePhone(raw: string | null | undefined, defaultCountry = "91"): string | null {
  if (!raw) return null;
  let d = raw.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0") && d.length === 11) d = defaultCountry + d.slice(1);
  else if (d.length === 10) d = defaultCountry + d;
  if (!/^\d{11,15}$/.test(d)) return null;
  return `+${d}`;
}

/** Mask all but the last 4 digits for lists and logs. */
export function maskPhone(e164: string | null | undefined): string {
  if (!e164) return "—";
  return e164.replace(/\d(?=\d{4})/g, "•");
}
