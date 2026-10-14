import { parseAmount } from "./normalize.ts";

interface FinancingAmount {
  amountValue?: number | null;
  amountCurrency?: string | null;
  amountUsdMillions?: number | null;
  financingTotalAsWritten?: string | null;
}

export function financingTotalMatches(a: FinancingAmount, b: FinancingAmount): boolean {
  return [
    [a, b],
    [b, a],
  ].some(([amount, financing]) => {
    const total = parseAmount(financing.financingTotalAsWritten);
    const value =
      (total.currency && total.currency === amount.amountCurrency ? amount.amountValue : null) ??
      (total.currency === "USD" ? amount.amountUsdMillions : null);
    if (value == null || total.value === null || value <= 0 || total.value <= 0) return false;
    return Math.abs(value - total.value) <= 0.05 * Math.max(value, total.value);
  });
}

/**
 * How far a figure may sit from the one it was written for: half a unit of its last stated digit ("$2
 * billion" is any figure from $1.5 billion up, "$39 million" covers $39.3 million), never more than
 * `cap` of it. A figure with no number in it allows nothing.
 */
export function writtenSlack(asWritten: string | null | undefined, cap = 0.1): number {
  const value = parseAmount(asWritten).value;
  const number = /\d[\d,]*(?:\.(\d+))?/.exec(asWritten ?? "");
  if (value === null || !number) return 0;
  const digits = Number(number[0].replace(/,/g, ""));
  if (!digits) return 0;
  const half = (0.5 * 10 ** -(number[1]?.length ?? 0) * value) / digits;
  return Math.min(half, cap * value);
}

/**
 * Whether two readings are two closes of one financing: one states a total the two amounts add up to,
 * to the precision it is written. Starling's £50 million extension "takes the total raised in the Series
 * D round to £322 million", its £272 million first close and the extension together; SpaceX's $250
 * million of August 2022 and its $1.68 billion of June make the "$2 billion" the June filing stated.
 */
export function financingTotalSplits(a: FinancingAmount, b: FinancingAmount): boolean {
  return [
    [a, b],
    [b, a],
  ].some(([withTotal, other]) => {
    const total = parseAmount(withTotal.financingTotalAsWritten);
    if (total.value === null || total.value <= 0 || !total.currency) return false;
    const x = inCurrency(withTotal, total.currency);
    const y = inCurrency(other, total.currency);
    if (x == null || y == null || x <= 0 || y <= 0 || Math.abs(x - y) <= 0.05 * Math.max(x, y)) return false;
    return Math.abs(x + y - total.value) <= Math.max(0.02 * total.value, writtenSlack(withTotal.financingTotalAsWritten));
  });
}

/**
 * Whether two readings state different totals for their financing: two reports of one close give the
 * same running total, so PhonePe's April 2023 $100 million ("total funding rises to $850 million") is not
 * its February $100 million (a total of $450 million).
 */
export function financingTotalsDiffer(a: FinancingAmount, b: FinancingAmount): boolean {
  const x = parseAmount(a.financingTotalAsWritten);
  const y = parseAmount(b.financingTotalAsWritten);
  if (x.value === null || y.value === null || x.value <= 0 || y.value <= 0 || !x.currency || x.currency !== y.currency) return false;
  const slack = Math.max(
    0.05 * Math.max(x.value, y.value),
    writtenSlack(a.financingTotalAsWritten),
    writtenSlack(b.financingTotalAsWritten),
  );
  return Math.abs(x.value - y.value) > slack;
}

function inCurrency(x: FinancingAmount, currency: string): number | null {
  return (currency === x.amountCurrency ? x.amountValue : null) ?? (currency === "USD" ? (x.amountUsdMillions ?? null) : null);
}
