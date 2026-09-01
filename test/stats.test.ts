import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import { meanDelta, rate, rateDelta, summarize, wilson95 } from "../src/stats";
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
