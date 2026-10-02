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
