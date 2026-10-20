import { Pool, PoolClient } from "pg";
import { can, Action, Module, Role } from "./permissions";

// The app MUST connect as the non-owner role (erp_app) so row-level security applies.
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export class AuthzError extends Error { constructor(msg = "Accès refusé") { super(msg); this.name = "AuthzError"; } }

export type Ctx = { userId: string; companyId: string; role: Role;
  approvalLimitUsd: bigint | null; approvalLimitCdf: bigint | null };

async function run<T>(userId: string, companyId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.user_id',$1,true), set_config('app.company_id',$2,true)", [userId, companyId]);
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}

/** Verifies, from the database, that the session user may do `action` on `module` in `companyId`.
 *  `sessionUserId` must come from a verified session, never from client input. */
export async function authorize(sessionUserId: string, companyId: string, module: Module, action: Action): Promise<Ctx> {
  const row = await run(sessionUserId, companyId, async c =>
    (await c.query("SELECT role, active, approval_limit_usd, approval_limit_cdf FROM memberships WHERE user_id=$1 AND company_id=$2",
      [sessionUserId, companyId])).rows[0]);
  if (!row || !row.active || !can(row.role as Role, module, action)) throw new AuthzError();
  return { userId: sessionUserId, companyId, role: row.role,
    approvalLimitUsd: row.approval_limit_usd === null ? null : BigInt(row.approval_limit_usd),
    approvalLimitCdf: row.approval_limit_cdf === null ? null : BigInt(row.approval_limit_cdf) };
}

/** Runs `fn` in one transaction scoped to the caller's company (RLS enforced by PostgreSQL). */
export const withTenant = <T>(ctx: Ctx, fn: (c: PoolClient) => Promise<T>) => run(ctx.userId, ctx.companyId, fn);

export async function audit(c: PoolClient, ctx: Ctx, action: string, entity: string,
  entityId?: string, before?: unknown, after?: unknown, ip?: string) {
  await c.query(`INSERT INTO audit_logs (company_id,user_id,action,entity,entity_id,before_state,after_state,ip)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [ctx.companyId, ctx.userId, action, entity, entityId ?? null,
    before === undefined ? null : ser(before), after === undefined ? null : ser(after), ip ?? null]);
}

export function canApproveAmount(ctx: Ctx, currency: "USD" | "CDF", amountMinor: bigint): boolean {
  if (ctx.role === "COMPANY_OWNER" || ctx.role === "SUPER_ADMIN") return true;
  const limit = currency === "USD" ? ctx.approvalLimitUsd : ctx.approvalLimitCdf;
  const abs = amountMinor < 0n ? -amountMinor : amountMinor;
  return limit !== null && abs <= limit;
}

// JSON that survives bigint (stored as {"$big":"123"}).
export const ser = (v: unknown) => JSON.stringify(v, (_k, x) => typeof x === "bigint" ? { $big: x.toString() } : x);
export const de = <T>(s: string): T => JSON.parse(s, (_k, x) => x && typeof x === "object" && "$big" in x ? BigInt(x.$big) : x);

/** Run-once per (company, key): a repeated or concurrent call returns the first result without re-running `fn`. */
export async function once<T>(ctx: Ctx, key: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenant(ctx, async c => {
    // A concurrent insert of the same key waits here until the other transaction commits or rolls back.
    const ins = await c.query("INSERT INTO idempotency_keys (company_id, idem_key) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [ctx.companyId, key]);
    if (!ins.rowCount) {
      const r = await c.query("SELECT result FROM idempotency_keys WHERE company_id=$1 AND idem_key=$2", [ctx.companyId, key]);
      return de<T>(r.rows[0].result);
    }
    const result = await fn(c);
    await c.query("UPDATE idempotency_keys SET result=$3 WHERE company_id=$1 AND idem_key=$2", [ctx.companyId, key, ser(result)]);
    return result;
  });
}
