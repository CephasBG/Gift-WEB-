import { PrismaClient, Prisma } from "@prisma/client";
import { can, Action, Module, Role } from "./permissions";

export const prisma = new PrismaClient();

export class AuthzError extends Error {
  constructor(msg = "Accès refusé") { super(msg); }
}

export type Ctx = { userId: string; companyId: string; role: Role;
  approvalLimitUsd: bigint | null; approvalLimitCdf: bigint | null };

/** Resolve the caller's membership from the DB on every request. Never trust a role or
 *  companyId sent by the client; `sessionUserId` must come from the verified session. */
export async function authorize(sessionUserId: string, companyId: string, module: Module, action: Action): Promise<Ctx> {
  const m = await prisma.membership.findUnique({ where: { userId_companyId: { userId: sessionUserId, companyId } } });
  if (!m || !m.active || !can(m.role as Role, module, action)) throw new AuthzError();
  return { userId: m.userId, companyId, role: m.role as Role,
    approvalLimitUsd: m.approvalLimitUsd, approvalLimitCdf: m.approvalLimitCdf };
}

/** Run work in a transaction with the RLS tenant variable set. */
export async function withTenant<T>(ctx: Ctx, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT set_config('app.company_id', ${ctx.companyId}, true)`;
    return fn(tx);
  });
}

export async function audit(tx: Prisma.TransactionClient, ctx: Ctx, action: string, entity: string,
  entityId?: string, before?: unknown, after?: unknown, ip?: string) {
  await tx.auditLog.create({ data: { companyId: ctx.companyId, userId: ctx.userId, action, entity,
    entityId, before: before as any, after: after as any, ip } });
}

/** Can this member approve an amount (minor units) in this currency? */
export function canApproveAmount(ctx: Ctx, currency: "USD" | "CDF", amountMinor: bigint): boolean {
  if (ctx.role === "COMPANY_OWNER" || ctx.role === "SUPER_ADMIN") return true;
  const limit = currency === "USD" ? ctx.approvalLimitUsd : ctx.approvalLimitCdf;
  return limit !== null && amountMinor <= limit;
}

/** Idempotent execution: replaying a key (double-click, offline-sync retry) returns the first result. */
export async function once<T>(ctx: Ctx, key: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return withTenant(ctx, async tx => {
    const existing = await tx.idempotencyKey.findUnique({ where: { companyId_key: { companyId: ctx.companyId, key } } });
    if (existing) return existing.result as T;
    const result = await fn(tx);
    await tx.idempotencyKey.create({ data: { companyId: ctx.companyId, key, result: result as any } });
    return result;
  });
}
