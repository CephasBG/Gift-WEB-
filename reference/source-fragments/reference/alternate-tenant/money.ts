import type { PoolClient } from "pg";
// Amounts are bigint minor units (cents / centimes). Never floats.
export type Currency = "USD" | "CDF";
export type Money = { amount: bigint; currency: Currency };
export const money = (amount: bigint, currency: Currency): Money => ({ amount, currency });

export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error(`Devises différentes (${a.currency}/${b.currency}) : conversion explicite requise`);
  return money(a.amount + b.amount, a.currency);
}

const SCALE = 12;
/** Parses a positive decimal string with at most 12 decimals into a scaled bigint. */
function parseRate(rate: string): bigint {
  if (!/^\d+(\.\d{1,12})?$/.test(rate)) throw new Error(`Taux de change invalide : "${rate}"`);
  const [i, f = ""] = rate.split(".");
  const r = BigInt(i + f.padEnd(SCALE, "0"));
  if (r <= 0n) throw new Error("Le taux de change doit être positif");
  return r;
}

/** Explicit conversion. `rate` = units of `to` per 1 unit of the money's own currency. Rounds half away from zero. */
export function convert(m: Money, to: Currency, rate: string): Money {
  if (m.currency === to) return m;
  const r = parseRate(rate), scale = 10n ** BigInt(SCALE);
  const neg = m.amount < 0n, abs = neg ? -m.amount : m.amount;
  const out = (abs * r + scale / 2n) / scale;
  return money(neg ? -out : out, to);
}

/** Latest rate effective on or before `at`; throws if none exists — a rate is never guessed. */
export async function rateAt(c: PoolClient, companyId: string, from: Currency, to: Currency, at: Date) {
  const { rows } = await c.query(`SELECT id, rate::text AS rate FROM exchange_rates
    WHERE company_id=$1 AND from_currency=$2 AND to_currency=$3 AND effective_at <= $4 ORDER BY effective_at DESC LIMIT 1`,
    [companyId, from, to, at]);
  if (!rows[0]) throw new Error(`Aucun taux de change ${from}→${to} défini pour le ${at.toISOString().slice(0, 10)}`);
  return rows[0] as { id: string; rate: string };
}

export function format(m: Money, locale = "fr-CD") {
  const sign = m.amount < 0n ? "-" : "", a = m.amount < 0n ? -m.amount : m.amount;
  const num = new Intl.NumberFormat(locale).format(Number(a / 100n)) + "," + (a % 100n).toString().padStart(2, "0");
  return `${sign}${num} ${m.currency === "USD" ? "$" : "FC"}`;
}
