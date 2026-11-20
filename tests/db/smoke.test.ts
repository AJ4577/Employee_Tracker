import { test, expect } from "vitest";
import { createDb } from "./harness";
test("migrations apply on clean database", async () => {
  const db = await createDb();
  const r = await db.query<{ n: number }>("select count(*)::int n from pg_tables where schemaname='public'");
  expect(r.rows[0]!.n).toBeGreaterThanOrEqual(20);
  const rls = await db.query<{ tablename: string }>("select tablename from pg_tables where schemaname='public' and not rowsecurity");
  expect(rls.rows).toEqual([]);
}, 60000);
