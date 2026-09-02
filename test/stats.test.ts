import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import { meanDelta, rate, rateDelta, summarize, tCritical95, wilson95 } from "../src/stats";
import { listPriceEquivalentUsd, PRICING } from "../src/pricing";

describe("summaries", () => {
  test("an empty sample has no mean, not a mean of zero", () => {
    const s = summarize([]);
    assert.equal(s.n, 0);
    assert.equal(s.mean, null);
    assert.equal(s.sd, null);
  });

  test("a single sample has no standard deviation", () => {
    const s = summarize([42]);
    assert.equal(s.mean, 42);
    assert.equal(s.sd, null, "sd of 0 would read as 'no variance', which we did not measure");
  });

  test("sample standard deviation", () => {
    const s = summarize([2, 4, 4, 4, 5, 5, 7, 9]);
    assert.equal(s.mean, 5);
    assert.ok(Math.abs((s.sd as number) - 2.13809) < 0.001);
  });
});

describe("confidence intervals for means", () => {
  test("a single sample has no standard error and no interval", () => {
    const s = summarize([42]);
    assert.equal(s.sem, null);
    assert.equal(s.ci95, null, "an interval from one observation would be fabricated");
  });

  test("an empty sample has neither", () => {
    const s = summarize([]);
    assert.equal(s.sem, null);
    assert.equal(s.ci95, null);
  });

  test("standard error is sd over root n", () => {
    const s = summarize([2, 4, 4, 4, 5, 5, 7, 9]);
    assert.ok(Math.abs((s.sem as number) - (s.sd as number) / Math.sqrt(8)) < 1e-12);
  });

  test("the interval is centred on the mean and uses Student t, not 1.96", () => {
    const s = summarize([10, 12, 14, 16, 18]); // mean 14, sd 3.1623, n=5
    const [lo, hi] = s.ci95 as [number, number];
    assert.ok(Math.abs((lo + hi) / 2 - 14) < 1e-9, "must be centred on the mean");

    const halfWidth = hi - 14;
    const normalHalfWidth = 1.959963984540054 * (s.sem as number);
    assert.ok(
      halfWidth > normalHalfWidth,
      "at n=5 the t interval must be wider than the normal approximation"
    );
    // t(df=4) = 2.776 vs z = 1.96 — about 42% wider.
    assert.ok(Math.abs(halfWidth / normalHalfWidth - 2.776 / 1.96) < 0.01);
  });

  test("t critical values shrink toward the normal value as df grows", () => {
    assert.equal(tCritical95(1), 12.706);
    assert.equal(tCritical95(4), 2.776);
    assert.equal(tCritical95(9), 2.262);
    assert.ok(tCritical95(30) > 1.96 && tCritical95(30) < 2.05);
    assert.ok(Math.abs(tCritical95(500) - 1.959963984540054) < 1e-9);
    assert.ok(Number.isNaN(tCritical95(0)), "df below 1 has no critical value");
  });

  test("the interval narrows as n grows for the same spread", () => {
    const small = summarize([10, 20, 30, 40, 50]);
    const large = summarize([10, 20, 30, 40, 50, 10, 20, 30, 40, 50, 10, 20, 30, 40, 50]);
    const smallWidth = (small.ci95 as [number, number])[1] - (small.ci95 as [number, number])[0];
    const largeWidth = (large.ci95 as [number, number])[1] - (large.ci95 as [number, number])[0];
    assert.ok(largeWidth < smallWidth);
  });
});

describe("rates", () => {
  test("a rate over zero runs is null, not zero", () => {
    const r = rate(0, 0);
    assert.equal(r.rate, null);
    assert.equal(r.ci95, null);
  });

  test("5/5 does not claim certainty", () => {
    const r = rate(5, 5);
    assert.equal(r.rate, 1);
    const [lo, hi] = r.ci95 as [number, number];
    assert.ok(lo < 0.6, `lower bound ${lo} should be far below 1 at n=5`);
    assert.equal(hi, 1);
  });

  test("0/5 does not claim certainty either", () => {
    const [lo, hi] = wilson95(0, 5);
    assert.equal(lo, 0);
    assert.ok(hi > 0.4, `upper bound ${hi} should be well above 0 at n=5`);
  });

  test("deltas are null when either side is unmeasurable", () => {
    assert.equal(rateDelta(rate(1, 2), rate(0, 0)), null);
    assert.equal(meanDelta(summarize([1]), summarize([])), null);
  });
});

describe("list-price equivalent cost", () => {
  test("uses published per-token prices", () => {
    const usd = listPriceEquivalentUsd("claude-opus-5", {
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      total: 1_000_000,
    });
    assert.equal(usd, PRICING["claude-opus-5"]?.input);
  });

  test("an unknown model gives null rather than a made-up number", () => {
    const usd = listPriceEquivalentUsd("some-model-we-do-not-price", {
      input: 1000,
      output: 1000,
      cacheRead: 0,
      cacheCreation: 0,
      total: 2000,
    });
    assert.equal(usd, null);
  });

  test("cached tokens are cheaper than fresh input", () => {
    const p = PRICING["claude-opus-5"];
    assert.ok(p);
    assert.ok(p.cacheRead < p.input);
    assert.ok(p.cacheWrite > p.input);
  });
});
