/**
 * RFC 4180 CSV with spreadsheet formula-injection protection: cells starting with
 * = + - @ (or tab/CR) are prefixed with a single quote so Excel/Sheets won't execute them.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = Array.isArray(v) ? v.join("; ") : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<T extends Record<string, unknown>>(rows: T[], columns?: (keyof T & string)[]): string {
  const cols = columns ?? (rows[0] ? (Object.keys(rows[0]) as (keyof T & string)[]) : []);
  const lines = [cols.map(csvCell).join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))];
  return "﻿" + lines.join("\r\n");
}
