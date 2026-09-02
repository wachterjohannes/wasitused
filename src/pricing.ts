/**
 * List-price-equivalent cost estimation.
 *
 * This is NOT what a run cost. It is "what these token counts would cost at
 * published per-model list prices". Subscription plans, negotiated rates and
 * plan-specific caching behaviour are not reflected. Every surface that shows a
 * dollar figure must show COST_CAVEAT next to it.
 */

export const COST_CAVEAT =
  "List-price-equivalent estimate: token counts x published per-model list prices. " +
  "This is not a billed amount — subscription plans and negotiated rates are not reflected.";

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Cache read is 0.1x input and 5-minute cache write is 1.25x input for the
 * Claude models below; those multipliers are applied rather than re-typed.
 */
function price(input: number, output: number): ModelPrice {
  return { input, output, cacheRead: input * 0.1, cacheWrite: input * 1.25 };
}

export const PRICING: Record<string, ModelPrice> = {
  "claude-fable-5": price(10, 50),
  "claude-opus-5": price(5, 25),
  "claude-opus-4-8": price(5, 25),
  "claude-opus-4-7": price(5, 25),
  "claude-opus-4-6": price(5, 25),
  "claude-sonnet-5": price(2, 10),
  "claude-sonnet-4-6": price(3, 15),
  "claude-haiku-4-5": price(1, 5),
};

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
}

export function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
}

/** null when the model id has no published price in the table — never guessed. */
export function listPriceEquivalentUsd(
  model: string,
  totals: TokenTotals
): number | null {
  const p = PRICING[model];
  if (!p) return null;
  return (
    (totals.input * p.input +
      totals.output * p.output +
      totals.cacheRead * p.cacheRead +
      totals.cacheCreation * p.cacheWrite) /
    1_000_000
  );
}

export type UsdSource = "agent-reported" | "price-table" | "unavailable";

export interface UsdEstimate {
  usd: number | null;
  source: UsdSource;
}

/**
 * The best available list-price-equivalent figure for a run.
 *
 * The agent's own total is preferred where it exists: it covers every model the
 * run touched, including auxiliary ones this table does not price. Falling back
 * to the table is fine but will under-count a run that used a helper model.
 * Shared so the live run loop and the metrics pass cannot drift apart.
 */
export function bestEffortUsd(
  model: string,
  totals: TokenTotals,
  reportedCostUsd: number | null
): UsdEstimate {
  if (reportedCostUsd !== null) return { usd: reportedCostUsd, source: "agent-reported" };
  const fromTable = listPriceEquivalentUsd(model, totals);
  return fromTable === null
    ? { usd: null, source: "unavailable" }
    : { usd: fromTable, source: "price-table" };
}
