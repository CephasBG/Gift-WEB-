import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { Ctx, withTenant, audit, once } from "./tenant";
import { ValidationError } from "./finance";

export const SIGN = { PURCHASE: 1, ADJUSTMENT_IN: 1, ISSUE: -1, DAMAGED: -1, LOST: -1, EXPIRED: -1, ADJUSTMENT_OUT: -1 } as const;
export type Reason = keyof typeof SIGN;
export const REASON_FR: Record<Reason, string> = { PURCHASE: "Réception / achat", ISSUE: "Sortie (consommation)", DAMAGED: "Endommagé", LOST: "Perdu", EXPIRED: "Périmé",
  ADJUSTMENT_IN: "Ajustement (+)", ADJUSTMENT_OUT: "Ajustement (−)" };

function qty(s: string): bigint {
  const t = String(s ?? "").trim();
  if (!/^\d{1,9}$/.test(t) || BigInt(t) <= 0n) throw new ValidationError("Quantité invalide (nombre entier supérieur à zéro)");
  return BigInt(t);
}
const clean = (s: string, max: number, what: string) => { const t = String(s ?? "").trim(); if (!t || t.length > max) throw new ValidationError(`${what} requis (${max} caractères maximum)`); return t; };
const dup = (e: any, msg: string) => { if (e?.code === "23505") throw new ValidationError(msg); throw e; };

export async function createWarehouse(ctx: Ctx, name: string, location = "") {
  const n = clean(name, 100, "Nom de l’entrepôt");
  return withTenant(ctx, async c => {
    const id = (await c.query("INSERT INTO warehouses (company_id,name,location) VALUES ($1,$2,$3) RETURNING id", [ctx.companyId, n, location.trim() || null]).catch(e => dup(e, "Un entrepôt porte déjà ce nom"))).rows[0].id;
    await audit(c, ctx, "warehouse.create", "warehouse", id, undefined, { name: n }); return id as string;
  });
}
export async function createProduct(ctx: Ctx, i: { code: string; name: string; unit?: string; minStock?: string; barcode?: string }) {
  const code = clean(i.code, 40, "Code"), name = clean(i.name, 150, "Désignation");
  const min = i.minStock?.trim() ? qty(i.minStock) : 0n;
  return withTenant(ctx, async c => {
    const id = (await c.query("INSERT INTO products (company_id,code,name,unit,barcode,min_stock) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [ctx.companyId, code, name, i.unit?.trim() || "unité", i.barcode?.trim() || null, min.toString()]).catch(e => dup(e, "Ce code produit existe déjà"))).rows[0].id;
    await audit(c, ctx, "product.create", "product", id, undefined, { code, name }); return id as string;
  });
}

async function lock(c: PoolClient, ctx: Ctx, product: string, wh: string) {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${ctx.companyId}|${product}|${wh}`]);
}
async function onHand(c: PoolClient, product: string, wh: string) {
  return BigInt((await c.query("SELECT COALESCE(SUM(quantity),0)::text q FROM stock_movements WHERE product_id=$1 AND warehouse_id=$2", [product, wh])).rows[0].q);
}
async function mustExist(c: PoolClient, table: "products" | "warehouses", id: string) {
  if (!(await c.query(`SELECT 1 FROM ${table} WHERE id=$1`, [id])).rowCount) throw new ValidationError(table === "products" ? "Produit introuvable" : "Entrepôt introuvable");
}
async function insert(c: PoolClient, ctx: Ctx, product: string, wh: string, q: bigint, reason: string, note: string | null, transferId: string | null) {
  const id = (await c.query(`INSERT INTO stock_movements (company_id,product_id,warehouse_id,quantity,reason,note,transfer_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.companyId, product, wh, q.toString(), reason, note, transferId, ctx.userId])).rows[0].id;
  await audit(c, ctx, "stock." + reason.toLowerCase(), "stock_movement", id, undefined, { product, wh, quantity: q, note });
}

/** Records one stock movement. `key` (optional) makes a double-submit or sync replay harmless. */
export async function recordMovement(ctx: Ctx, i: { productId: string; warehouseId: string; reason: string; quantity: string; note?: string; key?: string }) {
  if (!(i.reason in SIGN)) throw new ValidationError("Motif invalide");
  const reason = i.reason as Reason, q = qty(i.quantity), note = i.note?.trim() || null;
  if ((reason === "ADJUSTMENT_IN" || reason === "ADJUSTMENT_OUT") && !note) throw new ValidationError("Une justification est obligatoire pour un ajustement");
  const work = async (c: PoolClient) => {
    await mustExist(c, "products", i.productId); await mustExist(c, "warehouses", i.warehouseId);
    await lock(c, ctx, i.productId, i.warehouseId);
    if (SIGN[reason] < 0 && (await onHand(c, i.productId, i.warehouseId)) < q) throw new ValidationError("Stock insuffisant dans cet entrepôt");
    await insert(c, ctx, i.productId, i.warehouseId, q * BigInt(SIGN[reason]), reason, note, null);
    return true;
  };
  await (i.key ? once(ctx, "stock:" + i.key, work) : withTenant(ctx, work));
}

export async function transfer(ctx: Ctx, i: { productId: string; fromId: string; toId: string; quantity: string; note?: string; key?: string }) {
  const q = qty(i.quantity); if (i.fromId === i.toId) throw new ValidationError("Choisissez deux entrepôts différents");
  const work = async (c: PoolClient) => {
    await mustExist(c, "products", i.productId); await mustExist(c, "warehouses", i.fromId); await mustExist(c, "warehouses", i.toId);
    for (const w of [i.fromId, i.toId].sort()) await lock(c, ctx, i.productId, w);        // fixed order: no deadlocks
    if ((await onHand(c, i.productId, i.fromId)) < q) throw new ValidationError("Stock insuffisant dans l’entrepôt d’origine");
    const t = randomUUID(), note = i.note?.trim() || null;
    await insert(c, ctx, i.productId, i.fromId, -q, "TRANSFER_OUT", note, t);
    await insert(c, ctx, i.productId, i.toId, q, "TRANSFER_IN", note, t);
    return true;
  };
  await (i.key ? once(ctx, "transfer:" + i.key, work) : withTenant(ctx, work));
}

export const listProducts = (ctx: Ctx) => withTenant(ctx, async c => (await c.query("SELECT id, code, name, unit, min_stock::text FROM products ORDER BY code")).rows as { id: string; code: string; name: string; unit: string; min_stock: string }[]);
export const listWarehouses = (ctx: Ctx) => withTenant(ctx, async c => (await c.query("SELECT id, name, location FROM warehouses ORDER BY name")).rows as { id: string; name: string; location: string | null }[]);

export type Level = { id: string; code: string; name: string; unit: string; min_stock: string; total: string; low: boolean; byWarehouse: { warehouse: string; qty: string }[] };
export const levels = (ctx: Ctx) => withTenant(ctx, async c => {
  const p = (await c.query(`SELECT p.id, p.code, p.name, p.unit, p.min_stock::text, COALESCE(SUM(m.quantity),0)::text total
    FROM products p LEFT JOIN stock_movements m ON m.product_id=p.id GROUP BY p.id ORDER BY p.code`)).rows;
  const w = (await c.query(`SELECT m.product_id, wh.name warehouse, SUM(m.quantity)::text qty FROM stock_movements m JOIN warehouses wh ON wh.id=m.warehouse_id
    GROUP BY m.product_id, wh.name HAVING SUM(m.quantity) <> 0 ORDER BY wh.name`)).rows;
  return p.map(r => ({ ...r, low: BigInt(r.total) < BigInt(r.min_stock), byWarehouse: w.filter(x => x.product_id === r.id).map(x => ({ warehouse: x.warehouse, qty: x.qty })) })) as Level[];
});
export const history = (ctx: Ctx, limit = 50) => withTenant(ctx, async c => (await c.query(`SELECT to_char(m.created_at AT TIME ZONE 'Africa/Kinshasa','DD/MM/YYYY HH24:MI') at, p.code, p.name product, wh.name warehouse, m.quantity::text, m.reason, m.note, u.name by
  FROM stock_movements m JOIN products p ON p.id=m.product_id JOIN warehouses wh ON wh.id=m.warehouse_id LEFT JOIN users u ON u.id=m.created_by ORDER BY m.created_at DESC LIMIT $1`, [limit])).rows as
  { at: string; code: string; product: string; warehouse: string; quantity: string; reason: Reason | "TRANSFER_IN" | "TRANSFER_OUT"; note: string | null; by: string }[]);
export const lowStockCount = async (ctx: Ctx) => (await levels(ctx)).filter(l => l.low).length;
