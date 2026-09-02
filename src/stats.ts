/** Tiny stats helpers. N is small here on purpose — report spread, never a bare mean. */

export interface Summary {
  n: number;
  mean: number | null;
  /** Sample standard deviation. null for n < 2 rather than a misleading 0. */
  sd: number | null;
  /** Standard error of the mean. null for n < 2. */
  sem: number | null;
  /** 95% confidence interval for the mean (Student t). null for n < 2. */
  ci95: [number, number] | null;
  min: number | null;
  max: number | null;
}

/**
 * Two-sided 95% Student t critical values by degrees of freedom.
 *
 * At the N this harness runs (5-30 per condition) the normal approximation is
 * meaningfully too narrow — at n=5 it understates the interval by about 30% —
 * and a too-narrow interval is exactly the error that makes a pilot look
 * conclusive. Above df=30 the difference is under 5% and 1.96 is used.
 */
const T_95: readonly number[] = [
  // index = df, starting at 1
  NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08,
  2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];

export function tCritical95(df: number): number {
  if (df < 1) return NaN;
  return df <= 30 ? (T_95[df] as number) : 1.959963984540054;
}

export function summarize(values: number[]): Summary {
  if (values.length === 0) {
    return { n: 0, mean: null, sd: null, sem: null, ci95: null, min: null, max: null };
  }
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  // Sample SD; undefined for n === 1 rather than a misleading 0.
  const sd =
    n < 2
      ? null
      : Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const sem = sd === null ? null : sd / Math.sqrt(n);
  const half = sem === null ? null : tCritical95(n - 1) * sem;
  return {
    n,
    mean,
    sd,
    sem,
    ci95: half === null ? null : [mean - half, mean + half],
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

export interface Rate {
  /** Numerator: successes/invocations. */
  k: number;
  /** Denominator: only runs where the quantity could be measured. */
  n: number;
  /** null when n === 0 — an unmeasurable rate is not 0. */
  rate: number | null;
  /** 95% Wilson score interval, null when n === 0. */
  ci95: [number, number] | null;
}

export function rate(k: number, n: number): Rate {
  if (n <= 0) return { k, n, rate: null, ci95: null };
  return { k, n, rate: k / n, ci95: wilson95(k, n) };
}

/**
 * Wilson score interval. Chosen over normal approximation because at N=5 with
 * k=0 or k=n the normal interval collapses to zero width, which reads as
 * certainty the data does not contain.
 */
export function wilson95(k: number, n: number): [number, number] {
  const z = 1.959963984540054;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const lo = (centre - spread) / denom;
  const hi = (centre + spread) / denom;
  return [Math.max(0, lo), Math.min(1, hi)];
}

/** Difference of two rates; null if either side is unmeasurable. */
export function rateDelta(a: Rate, b: Rate): number | null {
  if (a.rate === null || b.rate === null) return null;
  return a.rate - b.rate;
}

export function meanDelta(a: Summary, b: Summary): number | null {
  if (a.mean === null || b.mean === null) return null;
  return a.mean - b.mean;
}
