import * as SQLite from "expo-sqlite";

/**
 * Local offline queue in the app's private sandbox (protected by OS app isolation and device
 * encryption). Holds only what is needed to replay: idempotency keys, coordinates, outcome text.
 * Cleared on logout.
 */
let dbp: Promise<SQLite.SQLiteDatabase> | null = null;

export function db(): Promise<SQLite.SQLiteDatabase> {
  if (!dbp) {
    dbp = (async () => {
      const d = await SQLite.openDatabaseAsync("kisanroute.db");
      await d.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS points (
          client_event_id TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL,
          trip_id TEXT,
          device_time TEXT NOT NULL,
          lat REAL NOT NULL, lon REAL NOT NULL, accuracy_m REAL NOT NULL, speed_ms REAL
        );
        CREATE TABLE IF NOT EXISTS actions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          visit_id TEXT,
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          error TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      `);
      return d;
    })();
  }
  return dbp;
}

export async function kvGet(k: string): Promise<string | null> {
  const r = await (await db()).getFirstAsync<{ v: string }>("SELECT v FROM kv WHERE k = ?", [k]);
  return r?.v ?? null;
}
export async function kvSet(k: string, v: string | null): Promise<void> {
  const d = await db();
  if (v === null) await d.runAsync("DELETE FROM kv WHERE k = ?", [k]);
  else await d.runAsync("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [k, v]);
}

export async function nextSequence(): Promise<number> {
  const n = Number((await kvGet("seq")) ?? "0") + 1;
  await kvSet("seq", String(n));
  return n;
}

export async function clearLocalData(): Promise<void> {
  const d = await db();
  await d.execAsync("DELETE FROM points; DELETE FROM actions; DELETE FROM kv WHERE k NOT IN ('seq');");
}

export async function pendingCounts(): Promise<{ points: number; actions: number; rejected: number }> {
  const d = await db();
  const p = await d.getFirstAsync<{ n: number }>("SELECT COUNT(*) n FROM points");
  const a = await d.getFirstAsync<{ n: number }>("SELECT COUNT(*) n FROM actions WHERE status = 'pending'");
  const r = await d.getFirstAsync<{ n: number }>("SELECT COUNT(*) n FROM actions WHERE status = 'rejected'");
  return { points: p?.n ?? 0, actions: a?.n ?? 0, rejected: r?.n ?? 0 };
}
