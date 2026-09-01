/**
 * Failure modes at the metrics layer.
 *
 * The expensive mistakes are not crashes — they are numbers that look fine.
 * A dud counted as a failure, a null coerced to false, an efficacy delta
 * attributed to a tool that was never called: each produces a clean-looking
 * report that is wrong. These tests pin all three.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import { test, describe, after } from "node:test";
import { computeBatchMetrics } from "../src/metrics";
import {
  assistantLine,
  bashCall,
  initLine,
  makeBatchDir,
  resultLine,
  tmpDir,
  transcript,
} from "./helpers";

const created: string[] = [];
function scratch(name: string): string {
  const dir = tmpDir(name);
  created.push(dir);
  return dir;
}
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

/** A normal run: real tokens, optionally an invocation. */
function realRun(invoked: boolean, tokens = 1000): string {
  const content = invoked
    ? [bashCall("toolu_01", "tools/phrasebook greeting fr")]
    : [{ type: "text", text: "done" }];
  return transcript([
    initLine(),
    assistantLine("msg_01", { input_tokens: tokens, output_tokens: 100 }, content),
    resultLine(),
  ]);
}

/** A dud: the process ran, produced a clean-looking transcript, and spent nothing. */
function zeroCostRun(): string {
  return transcript([
    initLine(),
    assistantLine("msg_01", { input_tokens: 0, output_tokens: 0 }),
    resultLine("error_during_execution", true),
  ]);
}

describe("dud guard at the metrics layer", () => {
  test("zero-cost runs are excluded, counted out loud, and are not failures", () => {
    const dir = scratch("dud");
    const batchDir = makeBatchDir(dir, [
      // Baseline: one real pass, one real fail.
      { condition: "baseline", index: 1, transcript: realRun(false), check: { solved: true } },
      { condition: "baseline", index: 2, transcript: realRun(false), check: { solved: false } },
      // With tool: one real pass, plus two duds that a naive harness would
      // record as "the tool failed twice".
      { condition: "with_tool", index: 1, transcript: realRun(true), check: { solved: true } },
      { condition: "with_tool", index: 2, transcript: zeroCostRun(), check: { solved: false } },
      { condition: "with_tool", index: 3, transcript: zeroCostRun(), check: { solved: false } },
    ]);

    const m = computeBatchMetrics(batchDir);
    const w = m.conditions.with_tool;

    assert.equal(w.runsAttempted, 3);
    assert.equal(w.excluded.dudZeroCost, 2);
    assert.equal(w.usable, 1);

    // The decisive assertion: 1/1, not 1/3.
    assert.equal(w.efficacy.passRate.k, 1);
    assert.equal(w.efficacy.passRate.n, 1);
    assert.equal(w.efficacy.passRate.rate, 1);
    assert.equal(w.efficacy.notSolved, 0, "duds must not be counted as failures");

    assert.ok(
      m.warnings.some((x) => x.includes("excluded as unusable") && x.includes("NOT counted as failures")),
      "the exclusion must be stated in the report, not applied silently"
    );
  });

  test("an expired credential on a run is surfaced even when the run looks fine", () => {
    const dir = scratch("expired");
    const batchDir = makeBatchDir(dir, [
      { condition: "baseline", index: 1, transcript: realRun(false), check: { solved: true } },
      {
        condition: "with_tool",
        index: 1,
        transcript: zeroCostRun(),
        check: { solved: false },
        record: {
          exitCode: 0,
          credential: {
            source: "config-file",
            copied: true,
            expiresAt: 1,
            remainingMs: -5000,
            remainingHuman: "-0h00m",
            expired: true,
          },
        },
      },
    ]);

    const m = computeBatchMetrics(batchDir);
    assert.ok(
      m.warnings.some((x) => x.includes("already-expired credential")),
      "an exit-0, zero-cost run with a dead token must not pass silently"
    );
  });
});

describe("unparseable transcripts", () => {
  test("solved becomes null, the run is excluded, and the count is not silently dropped", () => {
    const dir = scratch("malformed");
    const batchDir = makeBatchDir(dir, [
      { condition: "baseline", index: 1, transcript: realRun(false), check: { solved: true } },
      { condition: "baseline", index: 2, transcript: realRun(false), check: { solved: false } },
      { condition: "with_tool", index: 1, transcript: realRun(true), check: { solved: true } },
      {
        condition: "with_tool",
        index: 2,
        // Truncated mid-write, as if the process was killed.
        transcript: realRun(true).slice(0, -40),
        // The check DID run and DID say "solved" — that claim must not survive
        // a transcript we cannot read, because invocation cannot be established.
        check: { solved: true, reason: "check exited 0" },
      },
    ]);

    const m = computeBatchMetrics(batchDir);
    const broken = m.runs.find((r) => r.runId === "with_tool-002");

    assert.ok(broken);
    assert.equal(broken.exclusion, "unparseable-transcript");
    assert.equal(broken.solved, null, "an unreadable run cannot report an outcome");
    assert.ok(broken.exclusionReason?.includes("malformed"));

    // Present in the run count, excluded from the rates, and said out loud.
    assert.equal(m.runs.length, 4, "the run must still appear in the run list");
    assert.equal(m.conditions.with_tool.runsAttempted, 2);
    assert.equal(m.conditions.with_tool.excluded.unparseableTranscript, 1);
    assert.equal(m.conditions.with_tool.usable, 1);
    assert.ok(
      m.warnings.some((x) => x.includes("unparseable transcripts")),
      "the reported run count must not shrink without an explanation"
    );
  });

  test("computing metrics twice from disk gives the same answer", () => {
    const dir = scratch("recompute");
    const batchDir = makeBatchDir(dir, [
      { condition: "baseline", index: 1, transcript: realRun(false), check: { solved: false } },
      { condition: "with_tool", index: 1, transcript: realRun(true), check: { solved: true } },
    ]);
    const a = computeBatchMetrics(batchDir);
    const b = computeBatchMetrics(batchDir);
    assert.deepEqual(
      { ...a, generatedAt: null },
      { ...b, generatedAt: null },
      "metrics must be reproducible from the stored artifacts alone"
    );
  });
});

describe("solved: null is not false", () => {
  test("indeterminate checks leave the pass rate denominator, and are reported", () => {
    const dir = scratch("null");
    const batchDir = makeBatchDir(dir, [
      { condition: "baseline", index: 1, transcript: realRun(false), check: { solved: true } },
      {
        condition: "baseline",
        index: 2,
        transcript: realRun(false),
        check: { solved: null, reason: "check timed out" },
      },
      { condition: "with_tool", index: 1, transcript: realRun(true), check: { solved: true } },
      { condition: "with_tool", index: 2, transcript: realRun(true), check: { solved: false } },
    ]);

    const m = computeBatchMetrics(batchDir);
    const b = m.conditions.baseline;

    assert.equal(b.usable, 2);
    assert.equal(b.efficacy.indeterminate, 1);
    // 1/1, not 1/2 — a measurement that did not happen is not a failure.
    assert.equal(b.efficacy.passRate.k, 1);
    assert.equal(b.efficacy.passRate.n, 1);
    assert.ok(m.warnings.some((x) => x.includes("solved=null")));
  });

  test("a pass rate with no determinate runs is null, not zero", () => {
    const dir = scratch("allnull");
    const batchDir = makeBatchDir(dir, [
      { condition: "baseline", index: 1, transcript: realRun(false), check: { solved: null } },
      { condition: "with_tool", index: 1, transcript: realRun(true), check: { solved: null } },
    ]);
    const m = computeBatchMetrics(batchDir);
    assert.equal(m.conditions.baseline.efficacy.passRate.rate, null);
    assert.equal(m.efficacy.deltaAllRuns, null, "an unmeasurable delta must not read as 0");
  });
});

describe("effects are conditioned on actual invocation", () => {
  test("a difference with 0/n invocation is not attributed to the tool", () => {
    const dir = scratch("noinvoke");
    const batchDir = makeBatchDir(dir, [
      { condition: "baseline", index: 1, transcript: realRun(false), check: { solved: false } },
      { condition: "baseline", index: 2, transcript: realRun(false), check: { solved: false } },
      // The tool was available and completely ignored, yet these runs passed.
      { condition: "with_tool", index: 1, transcript: realRun(false), check: { solved: true } },
      { condition: "with_tool", index: 2, transcript: realRun(false), check: { solved: true } },
    ]);

    const m = computeBatchMetrics(batchDir);

    assert.equal(m.efficacy.invocationCounts.withToolInvoked, 0);
    assert.equal(m.efficacy.deltaAllRuns, 1, "the naive delta looks like a +100pp win");
    assert.equal(
      m.efficacy.deltaInvokedOnly,
      null,
      "there is no invoked subset, so no attributable effect exists"
    );
    assert.ok(m.efficacy.note.includes("NOT an effect of the tool"));
    assert.ok(m.warnings.some((x) => x.includes("NOT an effect of the tool")));
  });

  test("cost deltas carry their invocation counts", () => {
    const dir = scratch("costdelta");
    const batchDir = makeBatchDir(dir, [
      { condition: "baseline", index: 1, transcript: realRun(false, 1000), check: { solved: false } },
      { condition: "baseline", index: 2, transcript: realRun(false, 1000), check: { solved: false } },
      { condition: "with_tool", index: 1, transcript: realRun(true, 5000), check: { solved: true } },
      { condition: "with_tool", index: 2, transcript: realRun(false, 1000), check: { solved: false } },
    ]);

    const m = computeBatchMetrics(batchDir);
    const tokens = m.cost.find((c) => c.metric === "total tokens");
    assert.ok(tokens);
    assert.equal(tokens.invocationCounts.withToolInvoked, 1);
    assert.equal(tokens.invocationCounts.withToolUsable, 2);
    // baseline mean 1100; with-tool all mean 3100; invoked-only mean 5100.
    assert.equal(tokens.baseline.mean, 1100);
    assert.equal(tokens.withToolAll.mean, 3100);
    assert.equal(tokens.withToolInvoked.mean, 5100);
    assert.equal(tokens.deltaAllRuns, 2000);
    assert.equal(tokens.deltaInvokedOnly, 4000);
  });

  test("an invocation in the baseline is flagged as an isolation leak", () => {
    const dir = scratch("leak");
    const batchDir = makeBatchDir(dir, [
      { condition: "baseline", index: 1, transcript: realRun(true), check: { solved: true } },
      { condition: "with_tool", index: 1, transcript: realRun(true), check: { solved: true } },
    ]);
    const m = computeBatchMetrics(batchDir);
    assert.ok(m.warnings.some((x) => x.includes("ISOLATION LEAK")));
  });
});

describe("over-use", () => {
  test("is measured only in tool-irrelevant scenarios", () => {
    const dir = scratch("overuse");
    const batchDir = makeBatchDir(
      dir,
      [
        { condition: "baseline", index: 1, transcript: realRun(false), check: { solved: true } },
        { condition: "with_tool", index: 1, transcript: realRun(true), check: { solved: true } },
        { condition: "with_tool", index: 2, transcript: realRun(false), check: { solved: true } },
      ],
      {},
      { toolRelevant: false }
    );

    const m = computeBatchMetrics(batchDir);
    assert.equal(m.overUse.applicable, true);
    assert.equal(m.overUse.rate?.k, 1);
    assert.equal(m.overUse.rate?.n, 2);
  });

  test("is not reported for tool-relevant scenarios", () => {
    const dir = scratch("nooveruse");
    const batchDir = makeBatchDir(dir, [
      { condition: "baseline", index: 1, transcript: realRun(false), check: { solved: true } },
      { condition: "with_tool", index: 1, transcript: realRun(true), check: { solved: true } },
    ]);
    const m = computeBatchMetrics(batchDir);
    assert.equal(m.overUse.applicable, false);
    assert.equal(m.overUse.rate, null);
  });
});

describe("pilot-scale honesty", () => {
  test("small N is labelled as not citable", () => {
    const dir = scratch("smalln");
    const batchDir = makeBatchDir(dir, [
      { condition: "baseline", index: 1, transcript: realRun(false), check: { solved: true } },
      { condition: "with_tool", index: 1, transcript: realRun(true), check: { solved: true } },
    ]);
    const m = computeBatchMetrics(batchDir);
    assert.ok(m.warnings.some((x) => x.includes("pilot scale")));
  });
});
