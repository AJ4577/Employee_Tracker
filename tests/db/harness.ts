/**
 * Runs the real Supabase migrations on an in-process Postgres (PGlite) with a minimal
 * stand-in for Supabase's auth schema and roles, so RLS and RPC behaviour can be tested
 * in CI without Docker. Production Supabase provides the real auth schema.
 */
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "supabase", "migrations");

const AUTH_STUB = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;
`;

export type Db = PGlite;

export async function createDb(): Promise<Db> {
  const db = new PGlite();
  await db.exec(AUTH_STUB);
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    try {
      await db.exec(readFileSync(join(migrationsDir, f), "utf8"));
    } catch (e) {
      throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
    }
  }
  // service_role needs table access like on Supabase
  await db.exec(`grant usage on schema public to service_role; grant all on all tables in schema public to service_role;`);
  return db;
}

export interface Claims {
  sub?: string;
  aal?: "aal1" | "aal2";
  role?: string;
  email?: string;
}

/** Run fn inside a transaction as the given JWT identity (role authenticated, or anon if no sub). */
export async function as<T>(db: Db, claims: Claims | null, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const role = claims?.sub ? "authenticated" : claims?.role ?? "anon";
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ ...(claims ?? {}), role })]);
    await tx.exec(`set local role ${role}`);
    return fn(tx);
  });
}

/** Expect a query to fail with the given error message code (raised via private.raise_err). */
export async function expectError(p: Promise<unknown>, code: string | RegExp): Promise<void> {
  try {
    await p;
  } catch (e) {
    const msg = (e as Error).message;
    if (typeof code === "string" ? msg === code || msg.includes(code) : code.test(msg)) return;
    throw new Error(`Expected error ${code}, got: ${msg}`);
  }
  throw new Error(`Expected error ${code}, but query succeeded`);
}

export interface World {
  orgA: string;
  orgB: string;
  ownerA: string;
  adminA: string;
  amit: string;
  neha: string;
  adminB: string;
  staffB: string;
  farmerA1: string;
  farmerA2: string;
  farmerB1: string;
  productA1: string;
  productB1: string;
}

/** Superuser setup of two organizations with users, farmers and products. */
export async function seedWorld(db: Db): Promise<World> {
  const w: World = {
    orgA: randomUUID(), orgB: randomUUID(), ownerA: randomUUID(), adminA: randomUUID(), amit: randomUUID(), neha: randomUUID(),
    adminB: randomUUID(), staffB: randomUUID(), farmerA1: randomUUID(), farmerA2: randomUUID(), farmerB1: randomUUID(),
    productA1: randomUUID(), productB1: randomUUID(),
  };
  await db.query(`insert into public.organizations (id, name, settings) values ($1, 'Org A', '{}'), ($2, 'Org B', '{"require_admin_mfa": false}')`, [w.orgA, w.orgB]);
  const users: [string, string, string, string][] = [
    [w.ownerA, w.orgA, "owner", "owner@a.test"],
    [w.adminA, w.orgA, "admin", "admin@a.test"],
    [w.amit, w.orgA, "staff", "amit@a.test"],
    [w.neha, w.orgA, "staff", "neha@a.test"],
    [w.adminB, w.orgB, "admin", "admin@b.test"],
    [w.staffB, w.orgB, "staff", "staff@b.test"],
  ];
  for (const [id, org, role, email] of users) {
    await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, email]);
    await db.query(`insert into public.profiles (id, organization_id, role, status, display_name, email) values ($1, $2, $3, 'active', $4, $4)`, [id, org, role, email]);
  }
  await db.query(`select set_config('kisanroute.verifying_location', 'on', false)`);
  await db.query(
    `insert into public.farmers (id, organization_id, name, phone, village, lat, lon, location_verified) values
     ($1, $4, 'Farmer A1', '9000000001', 'Village One', 18.7357, 73.6755, true),
     ($2, $4, 'Farmer A2', '9000000002', 'Village Two', null, null, false),
     ($3, $5, 'Farmer B1', '9000000009', 'Village B', 19.0, 73.0, true)`,
    [w.farmerA1, w.farmerA2, w.farmerB1, w.orgA, w.orgB],
  );
  await db.query(`select set_config('kisanroute.verifying_location', 'off', false)`);
  await db.query(
    `insert into public.products (id, organization_id, sku, name, unit, price) values ($1, $3, 'A-1', 'Product A1', 'kg', 128.50), ($2, $4, 'B-1', 'Product B1', 'kg', 10)`,
    [w.productA1, w.productB1, w.orgA, w.orgB],
  );
  return w;
}

export const admin = (id: string): Claims => ({ sub: id, aal: "aal2" });
export const user = (id: string): Claims => ({ sub: id, aal: "aal1" });
export const uuid = randomUUID;
