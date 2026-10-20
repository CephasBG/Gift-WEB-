import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { pool, getMember, Ctx } from "../src/lib/tenant";
import { signup, sessionFor } from "../src/lib/session";
import { ValidationError } from "../src/lib/finance";
import { createWarehouse, createProduct, recordMovement, transfer, levels, history, listProducts } from "../src/lib/inventory";
import { can } from "../src/lib/permissions";

const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER }), run = Date.now();
let A: Ctx, B: Ctx, p: string, w1: string, w2: string;
const boot = async (e: string) => { const s = (await sessionFor(await signup(`${run}${e}@inv.cd`, "motdepasse-long", e, "Inv " + e)))!; return (await getMember(s.userId, s.companyId))!; };
const lvl = async (c: Ctx, id = p) => (await levels(c)).find(l => l.id === id)!;
const mv = (reason: string, quantity: string, o: any = {}) => recordMovement(A, { productId: p, warehouseId: w1, reason, quantity, ...o });

beforeAll(async () => {
  A = await boot("a"); B = await boot("b");
  w1 = await createWarehouse(A, "Dépôt Lubumbashi", "Lubumbashi"); w2 = await createWarehouse(A, "Entrepôt Kinshasa");
  p = await createProduct(A, { code: "P-001", name: "Gasoil", unit: "litre", minStock: "50" });
});
afterAll(async () => { await pool.end(); await owner.end(); });

describe("catalogue", () => {
  it("rejects duplicate codes and warehouse names, and bad input", async () => {
    await expect(createProduct(A, { code: "P-001", name: "Autre" })).rejects.toThrow(/existe déjà/);
    await expect(createWarehouse(A, "Dépôt Lubumbashi")).rejects.toThrow(/déjà/);
    await expect(createProduct(A, { code: "", name: "x" })).rejects.toThrow(ValidationError);
    await expect(createProduct(A, { code: "Z", name: "x", minStock: "-3" })).rejects.toThrow(ValidationError);
  });
  it("the same code can exist in two companies", async () => { await createProduct(B, { code: "P-001", name: "Gasoil B" }); expect((await listProducts(B))).toHaveLength(1); });
});

describe("stock movements", () => {
  it("tracks quantities and low-stock status", async () => {
    await mv("PURCHASE", "100");
    expect((await lvl(A)).total).toBe("100"); expect((await lvl(A)).low).toBe(false);
    await mv("ISSUE", "60", { note: "Camion KAT-2210" });
    expect((await lvl(A))).toMatchObject({ total: "40", low: true });
  });
  it("refuses to take out more than is on hand", async () => {
    await expect(mv("ISSUE", "41")).rejects.toThrow(/insuffisant/);
    await expect(mv("LOST", "41")).rejects.toThrow(/insuffisant/);
    expect((await lvl(A)).total).toBe("40");
  });
  it("never goes negative under concurrent withdrawals", async () => {
    const r = await Promise.allSettled([mv("ISSUE", "30"), mv("ISSUE", "30"), mv("DAMAGED", "30")]);
    expect(r.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(BigInt((await lvl(A)).total)).toBeGreaterThanOrEqual(0n);
    await mv("PURCHASE", "60");
  });
  it("requires a justification for adjustments and validates quantities", async () => {
    await expect(mv("ADJUSTMENT_OUT", "1")).rejects.toThrow(/justification/);
    for (const q of ["0", "-5", "1.5", "abc", ""]) await expect(mv("PURCHASE", q)).rejects.toThrow(ValidationError);
    await expect(mv("HACK", "1")).rejects.toThrow(/Motif/);
  });
  it("a repeated submission with the same key is applied once", async () => {
    const before = BigInt((await lvl(A)).total);
    await Promise.all([1, 2, 3].map(() => mv("PURCHASE", "10", { key: "form-123" })));
    expect(BigInt((await lvl(A)).total)).toBe(before + 10n);
  });
  it("transfers keep the total, and fail atomically when stock is short", async () => {
    const total = (await lvl(A)).total;
    await transfer(A, { productId: p, fromId: w1, toId: w2, quantity: "20" });
    const l = await lvl(A); expect(l.total).toBe(total); expect(l.byWarehouse.find(x => x.warehouse === "Entrepôt Kinshasa")!.qty).toBe("20");
    const rows = (await history(A, 500)).length;
    await expect(transfer(A, { productId: p, fromId: w2, toId: w1, quantity: "21" })).rejects.toThrow(/insuffisant/);
    await expect(transfer(A, { productId: p, fromId: w1, toId: w1, quantity: "1" })).rejects.toThrow(/différents/);
    expect((await history(A, 500)).length).toBe(rows);
  });
  it("every movement is in the history with user and reason", async () => {
    const h = await history(A); expect(h[0].by).toBeTruthy(); expect(h.some(x => x.reason === "ISSUE" && x.note === "Camion KAT-2210")).toBe(true);
  });
});

describe("isolation and integrity", () => {
  it("cannot move stock using another company's product or warehouse", async () => {
    const pb = (await listProducts(B))[0].id;
    await expect(recordMovement(A, { productId: pb, warehouseId: w1, reason: "PURCHASE", quantity: "5" })).rejects.toThrow(/introuvable/);
    await expect(recordMovement(B, { productId: pb, warehouseId: w1, reason: "PURCHASE", quantity: "5" })).rejects.toThrow(/introuvable/);
    expect((await levels(B))[0].total).toBe("0");
  });
  it("the database itself rejects cross-company references", async () => {
    const pb = (await listProducts(B))[0].id, c = await owner.connect();
    try { await c.query("BEGIN"); await c.query("SELECT set_config('app.company_id',$1,true)", [A.companyId]);
      await expect(c.query("INSERT INTO stock_movements(company_id,product_id,warehouse_id,quantity,reason,created_by) VALUES ($1,$2,$3,5,'PURCHASE','x')", [A.companyId, pb, w1])).rejects.toThrow(/foreign key/);
    } finally { await c.query("ROLLBACK"); c.release(); }
  });
  it("movement history cannot be edited or deleted", async () => {
    await expect(pool.query("UPDATE stock_movements SET quantity=1")).rejects.toThrow();
    const c = await owner.connect();
    try { await c.query("BEGIN"); await c.query("SELECT set_config('app.company_id',$1,true)", [A.companyId]); await expect(c.query("DELETE FROM stock_movements")).rejects.toThrow(/append-only/); } finally { await c.query("ROLLBACK"); c.release(); }
  });
  it("role rules: stock manager can record, employee cannot manage", () => {
    expect(can("INVENTORY_MANAGER", "inventory", "create")).toBe(true); expect(can("ACCOUNTANT", "inventory", "create")).toBe(false);
  });
});
