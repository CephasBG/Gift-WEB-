// Amounts are always bigint minor units (cents / centimes). Never floats.
export type Currency = "USD" | "CDF";
export type Money = { amount: bigint; currency: Currency };

export const money = (amount: bigint, currency: Currency): Money => ({ amount, currency });

export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error(`Devises différentes (${a.currency}/${b.currency}) : conversion explicite requise`);
  return money(a.amount + b.amount, a.currency);
}

/** Explicit conversion only. `rate` = units of `to` per 1 unit of `from`, decimal string (e.g. "2800.000000").
 *  Store the rate row id on the converted document. */
export function convert(m: Money, to: Currency, rate: string): Money {
  if (m.currency === to) return m;
  const [i, f = ""] = rate.split(".");
  const scale = 10n ** 6n;
  const r = BigInt(i) * scale + BigInt((f + "000000").slice(0, 6));
  return money((m.amount * r + scale / 2n) / scale, to); // round half up
}

/** Latest rate effective on or before `at`. Throws if none: a rate is never guessed. */
export async function rateAt(tx: any, companyId: string, from: Currency, to: Currency, at: Date) {
  const row = await tx.exchangeRate.findFirst({
    where: { companyId, from, to, effectiveAt: { lte: at } }, orderBy: { effectiveAt: "desc" } });
  if (!row) throw new Error(`Aucun taux de change ${from}→${to} défini pour le ${at.toISOString().slice(0, 10)}`);
  return row;
}

export function format(m: Money, locale = "fr-CD") {
  return new Intl.NumberFormat(locale, { style: "currency", currency: m.currency }).format(Number(m.amount) / 100); // display only
}
