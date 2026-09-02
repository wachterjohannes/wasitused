/**
 * Shared rendering for numbers that carry uncertainty.
 *
 * The CLI and the HTML report show the same figures, so they format them the
 * same way and in one place — a mean that appears bare on the terminal and
 * with an interval in the report invites quoting whichever looks better.
 */

import type { Rate, Summary } from "./stats";

export function pct(value: number | null, digits = 0): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(digits)}%`;
}

export function signedPp(value: number | null, digits = 0): string {
  if (value === null) return "n/a";
  const s = `${(value * 100).toFixed(digits)}pp`;
  return value > 0 ? `+${s}` : s;
}

export function num(value: number | null, digits = 1): string {
  if (value === null) return "n/a";
  return digits === 0
    ? Math.round(value).toLocaleString("en-US")
    : value.toFixed(digits);
}

export function signedNum(value: number | null, digits = 1): string {
  if (value === null) return "n/a";
  const s = num(value, digits);
  return value > 0 ? `+${s}` : s;
}

/** e.g. `40% (2/5, 95% CI 12-77%)` — never a bare percentage. */
export function formatRate(r: Rate): string {
  if (r.rate === null) return `n/a (${r.n} usable runs)`;
  const ci = r.ci95 ? `, 95% CI ${pct(r.ci95[0])}-${pct(r.ci95[1])}` : "";
  return `${pct(r.rate)} (${r.k}/${r.n}${ci})`;
}

/** e.g. `133,043 (sd 24,110, 95% CI 103,111-162,975, n=5)`. */
export function formatSummary(s: Summary, digits = 1): string {
  if (s.mean === null) return "n/a (0 runs)";
  if (s.n === 1) return `${num(s.mean, digits)} (n=1, no spread available)`;
  const ci = s.ci95
    ? `, 95% CI ${num(s.ci95[0], digits)}-${num(s.ci95[1], digits)}`
    : "";
  return `${num(s.mean, digits)} (sd ${num(s.sd, digits)}${ci}, n=${s.n})`;
}

export function formatUsd(value: number | null): string {
  return value === null ? "n/a" : `$${value.toFixed(4)}`;
}

export function formatTokens(value: number | null): string {
  return value === null ? "n/a" : Math.round(value).toLocaleString("en-US");
}
