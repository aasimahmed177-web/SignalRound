// Currency conversion with a reproducible, dated rate.
// Source: Frankfurter (ECB and other central banks, no API key). https://frankfurter.dev
// The pure `convertToUsd` is what the pipeline and the tests use; `fetchRates` is the only network call.

export interface RateTable {
  /** ISO date the rates are for. */
  date: string;
  /** Units of currency per 1 USD, keyed by ISO 4217 code. */
  perUsd: Record<string, number>;
}

export interface UsdConversion {
  usd_millions: number | null;
  fx_rate: number | null;
  fx_date: string | null;
}

export function convertToUsd(valueMillions: number | null, currency: string | null, rates: RateTable | null): UsdConversion {
  if (valueMillions === null || !currency) return { usd_millions: null, fx_rate: null, fx_date: null };
  if (currency === "USD") return { usd_millions: valueMillions, fx_rate: 1, fx_date: rates?.date ?? null };
  const rate = rates?.perUsd[currency];
  if (!rate || !rates) return { usd_millions: null, fx_rate: null, fx_date: null };
  return { usd_millions: Math.round((valueMillions / rate) * 1000) / 1000, fx_rate: rate, fx_date: rates.date };
}

/** Rates for a given day (falls back to the nearest earlier business day server-side). */
export async function fetchRates(date: string | "latest" = "latest", fetchImpl: typeof fetch = fetch): Promise<RateTable> {
  const res = await fetchImpl(`https://api.frankfurter.dev/v1/${date}?base=USD`);
  if (!res.ok) throw new Error(`Frankfurter ${res.status} for ${date}`);
  const body = (await res.json()) as { date: string; rates: Record<string, number> };
  return { date: body.date, perUsd: body.rates };
}
