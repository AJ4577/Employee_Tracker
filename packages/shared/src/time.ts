export function formatInTz(iso: string | null | undefined, tz: string, opts?: Intl.DateTimeFormatOptions): string {
  if (!iso) return "Not recorded";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Invalid date";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: tz,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    ...opts,
  }).format(d);
}

export function formatDuration(fromIso: string | null | undefined, toIso: string | null | undefined): string {
  if (!fromIso || !toIso) return "Not recorded";
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return "Not recorded";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

export function timeAgo(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** Returns [startUtcIso, endUtcIso) for the calendar day containing `ref` in time zone `tz`. */
export function dayRangeInTz(tz: string, ref: Date = new Date()): [string, string] {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(ref)
    .reduce<Record<string, string>>((acc, p) => ((acc[p.type] = p.value), acc), {});
  const localMidnight = `${parts.year}-${parts.month}-${parts.day}T00:00:00`;
  const start = zonedToUtc(localMidnight, tz);
  const end = new Date(start.getTime() + 86400000);
  return [start.toISOString(), end.toISOString()];
}

/** Convert a wall-clock time "YYYY-MM-DDTHH:mm[:ss]" in `tz` to a UTC Date. */
export function zonedToUtc(local: string, tz: string): Date {
  const asUtc = new Date(`${local.length === 16 ? local + ":00" : local}Z`);
  const offset = tzOffsetMs(asUtc, tz);
  const guess = new Date(asUtc.getTime() - offset);
  const offset2 = tzOffsetMs(guess, tz);
  return offset2 === offset ? guess : new Date(asUtc.getTime() - offset2);
}

function tzOffsetMs(d: Date, tz: string): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(d)
    .reduce<Record<string, string>>((acc, x) => ((acc[x.type] = x.value), acc), {});
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return asUtc - d.getTime();
}

/** UTC ISO -> "YYYY-MM-DDTHH:mm" in tz, for <input type="datetime-local">. */
export function utcToLocalInput(iso: string, tz: string): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .formatToParts(new Date(iso))
    .reduce<Record<string, string>>((acc, x) => ((acc[x.type] = x.value), acc), {});
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
