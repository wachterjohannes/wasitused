/** Tiny stats helpers. N is small here on purpose — report spread, never a bare mean. */

export interface Summary {
  n: number;
  mean: number | null;
  sd: number | null;
  min: number | null;
  max: number | null;
}

export function summarize(values: number[]): Summary {
  if (values.length === 0) {
    return { n: 0, mean: null, sd: null, min: null, max: null };
  }
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  // Sample SD; undefined for n === 1 rather than a misleading 0.
  const sd =
    n < 2
      ? null
      : Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return {
    n,
    mean,
    sd,
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
