import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { exchangeRates } from "../src/db/schema";
import { authorize, withTenant, audit, once, pool, AuthzError, canApproveAmount } from "../src/lib/tenant";
import { rateAt } from "../src/lib/money";

const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER });
const ids: Record<string, string> = {};
/** Owner-role fixture helper: RLS is FORCEd, so even the owner must set a tenant context. */
const asOwner = async (company: string, sql: string, params: unknown[] = []) => {
  const c = await owner.connect();
  try { await c.query("BEGIN"); await c.query("SELECT set_config('app.company_id',$1,true)", [company]);
    const r = await c.query(sql, params); await c.query("COMMIT"); return r;
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
};
const run = Date.now();
const mkUser = async (e: string) => (await owner.query("INSERT INTO users(email,name,password_hash) VALUES ($1,$1,'x') RETURNING id", [run + e])).rows[0].id;
const signup = async (user: string, name: string) =>
  (await pool.query("SELECT create_company_with_owner($1,$2) AS id", [user, name])).rows[0].id as string;

beforeAll(async () => {
  ids.alice = await mkUser("alice@a.cd"); ids.bob = await mkUser("bob@b.cd"); ids.carl = await mkUser("carl@a.cd");
  ids.A = await signup(ids.alice, "Société A"); ids.B = await signup(ids.bob, "Société B");
  await asOwner(ids.A, "INSERT INTO memberships(user_id,company_id,role,approval_limit_usd) VALUES ($1,$2,'EMPLOYEE',NULL)", [ids.carl, ids.A]);
  for (const [co, rate] of [[ids.A, "2800"], [ids.B, "2900"]])
    await asOwner(co, "INSERT INTO exchange_rates(company_id,from_currency,to_currency,rate,effective_at,created_by) VALUES ($1,'USD','CDF',$2,'2026-01-01','seed')", [co, rate]);
});
afterAll(async () => { await pool.end(); await owner.end(); });

describe("tenant isolation", () => {
  it("sign-up creates company, owner membership and audit entry atomically", async () => {
    const ctx = await authorize(ids.alice, ids.A, "settings", "edit");
    expect(ctx.role).toBe("COMPANY_OWNER");
    const n = await withTenant(ctx, async c => (await c.query("SELECT count(*)::int n FROM audit_logs WHERE action='company.create'")).rows[0].n);
    expect(n).toBe(1);
  });
  it("a user of company A cannot authorize against company B", async () => {
    await expect(authorize(ids.alice, ids.B, "finance", "view")).rejects.toBeInstanceOf(AuthzError);
  });
  it("unfiltered queries only ever return the caller's company rows", async () => {
    const a = await authorize(ids.alice, ids.A, "finance", "view");
    const rows = await withTenant(a, async c => (await c.query("SELECT company_id, rate::text FROM exchange_rates")).rows);
    expect(rows).toHaveLength(1); expect(rows[0].company_id).toBe(ids.A);
    const cos = await withTenant(a, async c => (await c.query("SELECT id FROM companies")).rows);
    expect(cos.map(r => r.id)).toEqual([ids.A]);
  });
  it("cannot write rows into another company even with a forged company_id", async () => {
    const a = await authorize(ids.alice, ids.A, "finance", "create");
    await expect(withTenant(a, c => c.query(
      "INSERT INTO exchange_rates(company_id,from_currency,to_currency,rate,effective_at,created_by) VALUES ($1,'CDF','USD',0.0003,now(),'evil')", [ids.B]))).rejects.toThrow(/row-level security/);
  });
  it("with no tenant context, nothing is visible", async () => {
    const r = await pool.query("SELECT * FROM exchange_rates"); expect(r.rowCount).toBe(0);
    expect((await pool.query("SELECT * FROM audit_logs")).rowCount).toBe(0);
  });
  it("a user only sees their own memberships outside a company, never others'", async () => {
    const c = await pool.connect();
    try { await c.query("BEGIN"); await c.query("SELECT set_config('app.user_id',$1,true)", [ids.alice]);
      const r = await c.query("SELECT user_id FROM memberships"); expect(r.rows.every(x => x.user_id === ids.alice)).toBe(true); await c.query("ROLLBACK");
    } finally { c.release(); }
  });
});

describe("authorization", () => {
  it("restricted employee is refused finance and approval", async () => {
    await expect(authorize(ids.carl, ids.A, "finance", "view")).rejects.toBeInstanceOf(AuthzError);
    await expect(authorize(ids.carl, ids.A, "inventory", "approve")).rejects.toBeInstanceOf(AuthzError);
  });
  it("deactivated members are refused immediately", async () => {
    await asOwner(ids.A, "UPDATE memberships SET active=false WHERE user_id=$1", [ids.carl]);
    await expect(authorize(ids.carl, ids.A, "hr", "view")).rejects.toBeInstanceOf(AuthzError);
    await asOwner(ids.A, "UPDATE memberships SET active=true WHERE user_id=$1", [ids.carl]);
  });
  it("approval limits are enforced per currency, using absolute amounts", () => {
    const gm = { userId: "u", companyId: "c", role: "GENERAL_MANAGER" as const, approvalLimitUsd: 500000n, approvalLimitCdf: null };
    expect(canApproveAmount(gm, "USD", 500000n)).toBe(true);
    expect(canApproveAmount(gm, "USD", -500001n)).toBe(false);
    expect(canApproveAmount(gm, "CDF", 1n)).toBe(false);
  });
});

describe("integrity", () => {
  it("exchange-rate history cannot be edited or deleted by the app", async () => {
    const a = await authorize(ids.alice, ids.A, "finance", "edit");
    await expect(withTenant(a, c => c.query("UPDATE exchange_rates SET rate=1"))).rejects.toThrow(/permission denied/);
    await expect(withTenant(a, c => c.query("DELETE FROM exchange_rates"))).rejects.toThrow(/permission denied/);
  });
  it("audit log is append-only, even for the table owner", async () => {
    const a = await authorize(ids.alice, ids.A, "finance", "view");
    await withTenant(a, c => audit(c, a, "test.event", "thing", "1", { n: 1n }, { n: 2n }));
    await expect(withTenant(a, c => c.query("UPDATE audit_logs SET action='x'"))).rejects.toThrow();
    await expect(asOwner(ids.A, "DELETE FROM audit_logs")).rejects.toThrow(/append-only/);
  });
  it("rateAt returns the rate effective at the date and refuses to guess", async () => {
    const a = await authorize(ids.alice, ids.A, "finance", "view");
    const r = await withTenant(a, c => rateAt(c, ids.A, "USD", "CDF", new Date("2026-06-01")));
    expect(Number(r.rate)).toBe(2800);
    await expect(withTenant(a, c => rateAt(c, ids.A, "USD", "CDF", new Date("2025-06-01")))).rejects.toThrow(/Aucun taux/);
    await expect(withTenant(a, c => rateAt(c, ids.A, "CDF", "USD", new Date("2026-06-01")))).rejects.toThrow(/Aucun taux/);
  });
  it("once() runs the work a single time even under concurrent duplicates, and round-trips bigint", async () => {
    const a = await authorize(ids.alice, ids.A, "finance", "create");
    let runs = 0;
    const job = () => once(a, "pay-INV-1", async () => { runs++; await new Promise(r => setTimeout(r, 50)); return { paid: 123456789012345678n }; });
    const out = await Promise.all([job(), job(), job(), job(), job()]);
    expect(runs).toBe(1);
    for (const o of out) expect(o.paid).toBe(123456789012345678n);
  });
  it("a failed job does not burn its idempotency key", async () => {
    const a = await authorize(ids.alice, ids.A, "finance", "create");
    await expect(once(a, "retry-1", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await once(a, "retry-1", async () => "ok")).toBe("ok");
  });
  it("idempotency keys are per company", async () => {
    const a = await authorize(ids.alice, ids.A, "finance", "create"), b = await authorize(ids.bob, ids.B, "finance", "create");
    expect(await once(a, "same", async () => "A")).toBe("A");
    expect(await once(b, "same", async () => "B")).toBe("B");
  });
  it("drizzle schema matches the migrated database", async () => {
    const a = await authorize(ids.alice, ids.A, "finance", "view");
    const rows = await withTenant(a, c => drizzle(c).select().from(exchangeRates));
    expect(rows).toHaveLength(1); expect(rows[0].fromCurrency).toBe("USD");
  });
});
