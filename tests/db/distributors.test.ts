import { beforeAll, describe, expect, test } from "vitest";
import type { Transaction } from "@electric-sql/pglite";
import { admin, as, createDb, expectError, seedWorld, user, uuid, type Db, type World } from "./harness";

let db: Db;
let w: World;
const rpc = async <T = any>(tx: Transaction, sql: string, params: unknown[] = []): Promise<T> =>
  (await tx.query<{ r: T }>(`select ${sql} as r`, params)).rows[0]!.r;

beforeAll(async () => {
  db = await createDb();
  w = await seedWorld(db);
}, 60000);

describe("distributors", () => {
  let distId = "";

  test("admin creates a distributor; org and phone are set server-side; GSTIN validated", async () => {
    const r = await as(db, admin(w.adminA), (tx) =>
      tx.query<any>(`insert into public.distributors (organization_id, name, phone, gstin, village, district, postcode) values ($1, 'Pavani Pesticides', '98765 11111', '27abcde1234f1z5', 'Talegaon', 'Pune', '410506') returning *`, [w.orgB]),
    );
    distId = r.rows[0].id;
    expect(r.rows[0].organization_id).toBe(w.orgA);
    expect(r.rows[0].normalized_phone).toBe("+919876511111");
    expect(r.rows[0].gstin).toBe("27ABCDE1234F1Z5");
    expect(r.rows[0].location_verified).toBe(false);
    await expectError(as(db, admin(w.adminA), (tx) => tx.query(`insert into public.distributors (name, gstin) values ('Bad', 'XYZ')`)), /check constraint|violates/);
  });

  test("staff, other org and anonymous cannot see distributors or supplies", async () => {
    expect((await as(db, user(w.amit), (tx) => tx.query(`select * from public.distributors`))).rows).toEqual([]);
    expect((await as(db, admin(w.adminB), (tx) => tx.query(`select * from public.distributors`))).rows).toEqual([]);
    await expectError(as(db, null, (tx) => tx.query(`select * from public.distributors`)), /permission denied/);
    await expectError(as(db, user(w.amit), (tx) => rpc(tx, `public.admin_create_supply($1, now(), '[]'::jsonb, $2)`, [distId, uuid()])), "forbidden");
    await expectError(as(db, admin(w.adminB), (tx) => rpc(tx, `public.verify_distributor_location($1, 18.5, 73.8)`, [distId])), "not_found");
  });

  test("pin verification marks the location confirmed", async () => {
    const d = await as(db, admin(w.adminA), (tx) => rpc(tx, `public.verify_distributor_location($1, 18.7259, 73.6808, 'google_address')`, [distId]));
    expect(d).toMatchObject({ location_verified: true, geocode_source: "google_address" });
  });

  test("supply totals are computed server-side with price snapshots and are idempotent", async () => {
    const key = uuid();
    const items = JSON.stringify([{ product_id: w.productA1, quantity: "10" }, { product_id: w.productA1, quantity: 2, unit_price: "100" }]);
    const r = await as(db, admin(w.adminA), (tx) => rpc(tx, `public.admin_create_supply($1, now(), $2::jsonb, $3, 'INV-1')`, [distId, items, key]));
    const price = Number((await db.query<any>(`select price from public.products where id = $1`, [w.productA1])).rows[0].price);
    expect(Number(r.total)).toBeCloseTo(10 * price + 200, 2);
    const again = await as(db, admin(w.adminA), (tx) => rpc(tx, `public.admin_create_supply($1, now(), $2::jsonb, $3)`, [distId, items, key]));
    expect(again.replayed).toBe(true);
    await expectError(
      as(db, admin(w.adminA), (tx) => rpc(tx, `public.admin_create_supply($1, now(), $2::jsonb, $3)`, [distId, JSON.stringify([{ product_id: w.productB1, quantity: 1 }]), uuid()])),
      "validation",
    );
    await expectError(as(db, admin(w.adminA), (tx) => rpc(tx, `public.admin_void_supply($1, 'x')`, [r.supply_id])), "validation");
    const v = await as(db, admin(w.adminA), (tx) => rpc(tx, `public.admin_void_supply($1, 'wrong quantity')`, [r.supply_id]));
    expect(v.status).toBe("void");
    await expectError(db.query(`update public.distributor_supply_items set quantity = 1`), "append_only");
  });
});
