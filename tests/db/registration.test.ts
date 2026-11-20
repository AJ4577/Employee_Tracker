import { beforeAll, describe, expect, test } from "vitest";
import type { Transaction } from "@electric-sql/pglite";
import { as, createDb, expectError, uuid, type Db } from "./harness";

let db: Db;
const rpc = async <T = any>(tx: Transaction, sql: string, params: unknown[] = []): Promise<T> =>
  (await tx.query<{ r: T }>(`select ${sql} as r`, params)).rows[0]!.r;

const ids = { owner: uuid(), staff: uuid(), admin: uuid(), dup: uuid(), noEmail: uuid() };
const claims = (id: string, email?: string, aal: "aal1" | "aal2" = "aal2") => ({ sub: id, email, aal });

beforeAll(async () => {
  db = await createDb(); // fresh DB: no organizations yet
  for (const [k, id] of Object.entries(ids)) await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${k}@reg.test`]);
}, 60000);

describe("self-registration", () => {
  test("first registrant creates the organization and becomes active owner", async () => {
    const r = await as(db, claims(ids.owner, "owner@reg.test"), (tx) => rpc(tx, `public.register_profile('Owner Person', '98765 00001', 'staff')`));
    expect(r).toMatchObject({ status: "active", role: "owner" });
    await expectError(as(db, claims(ids.owner, "owner@reg.test"), (tx) => rpc(tx, `public.register_profile('Again', '9876500009', 'staff')`)), "already_registered");
  });

  test("later registrants are pending, owner is notified, pending users see no data", async () => {
    const s = await as(db, claims(ids.staff, "staff@reg.test"), (tx) => rpc(tx, `public.register_profile('Staff Person', '9876500002', 'staff')`));
    expect(s).toMatchObject({ status: "pending", role: "staff" });
    const a = await as(db, claims(ids.admin, "admin@reg.test"), (tx) => rpc(tx, `public.register_profile('Admin Person', '9876500003', 'admin')`));
    expect(a).toMatchObject({ status: "pending", role: "admin" });
    const n = await db.query<{ n: number }>(`select count(*)::int n from public.user_notifications where recipient_id = $1 and type = 'registration_pending'`, [ids.owner]);
    expect(n.rows[0]!.n).toBe(2);
    await expectError(as(db, claims(ids.staff, "staff@reg.test"), (tx) => rpc(tx, `public.my_visits()`)), "forbidden");
    await expectError(as(db, claims(ids.admin, "admin@reg.test"), (tx) => rpc(tx, `public.admin_overview(now() - interval '1 day', now())`)), "forbidden");
  });

  test("duplicate phone and missing verified email are rejected", async () => {
    await expectError(as(db, claims(ids.dup, "dup@reg.test"), (tx) => rpc(tx, `public.register_profile('Dup Person', '+91 98765 00002', 'staff')`)), "validation");
    await expectError(as(db, claims(ids.noEmail), (tx) => rpc(tx, `public.register_profile('No Email', '9876500005', 'staff')`)), "validation");
    await expectError(as(db, claims(ids.dup, "dup@reg.test"), (tx) => rpc(tx, `public.register_profile('Bad Phone', '123', 'staff')`)), "validation");
    await expectError(as(db, claims(ids.dup, "dup@reg.test"), (tx) => rpc(tx, `public.register_profile('Sneaky', '9876500006', 'owner')`)), "validation");
  });

  test("owner approves staff and admin; approved staff can work", async () => {
    // owner org requires MFA by default -> aal2 claim
    const s = await as(db, claims(ids.owner, "owner@reg.test"), (tx) => rpc(tx, `public.admin_review_registration($1, true)`, [ids.staff]));
    expect(s.status).toBe("active");
    const list = await as(db, claims(ids.staff, "staff@reg.test", "aal1"), (tx) => rpc<any[]>(tx, `public.my_visits()`));
    expect(list).toEqual([]);
    const a = await as(db, claims(ids.owner, "owner@reg.test"), (tx) => rpc(tx, `public.admin_review_registration($1, true)`, [ids.admin]));
    expect(a).toMatchObject({ status: "active", role: "admin" });
  });

  test("an admin cannot approve another admin, and approve/reject only applies to pending", async () => {
    await as(db, claims(ids.dup, "dup@reg.test"), (tx) => rpc(tx, `public.register_profile('Second Admin', '9876500007', 'admin')`));
    await expectError(as(db, claims(ids.admin, "admin@reg.test"), (tx) => rpc(tx, `public.admin_review_registration($1, true)`, [ids.dup])), "forbidden");
    // admin may approve it as staff instead
    const r = await as(db, claims(ids.admin, "admin@reg.test"), (tx) => rpc(tx, `public.admin_review_registration($1, true, 'staff')`, [ids.dup]));
    expect(r).toMatchObject({ status: "active", role: "staff" });
    await expectError(as(db, claims(ids.admin, "admin@reg.test"), (tx) => rpc(tx, `public.admin_review_registration($1, false)`, [ids.dup])), "invalid_transition");
    await expectError(as(db, claims(ids.staff, "staff@reg.test", "aal1"), (tx) => rpc(tx, `public.admin_review_registration($1, true)`, [ids.dup])), "forbidden");
  });

  test("rejecting suspends the account", async () => {
    await as(db, claims(ids.noEmail, "noemail@reg.test"), (tx) => rpc(tx, `public.register_profile('Rejected Person', '9876500008', 'staff')`));
    const r = await as(db, claims(ids.owner, "owner@reg.test"), (tx) => rpc(tx, `public.admin_review_registration($1, false, null, 'unknown person')`, [ids.noEmail]));
    expect(r.status).toBe("suspended");
  });
});
