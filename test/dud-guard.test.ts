/**
 * Failure mode: broken credentials producing runs that look legitimate.
 *
 * An expired token gives you exit 0, a well-formed transcript, one turn and
 * zero tokens. Nothing about it says "this is not a result". Left alone, a
 * batch of those becomes a row of confident zeros in a report. The guard's job
 * is to stop the batch loudly instead.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { test, describe, after } from "node:test";
import { computeBatchMetrics } from "../src/metrics";
import {
  DudGuardError,
  DUD_GUARD_THRESHOLD,
  runBatch,
  type SpawnAgentFn,
} from "../src/runner";
import type { BatchRecord } from "../src/types";
import {
  assistantLine,
  bashCall,
  initLine,
  makeScenarioDir,
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

/** Stands in for `claude -p`: writes the transcript the real agent would have. */
function fakeAgent(transcriptFor: (n: number) => string): SpawnAgentFn {
  let n = 0;
  return async (req) => {
    fs.writeFileSync(req.transcriptFile, transcriptFor(n++));
    fs.writeFileSync(req.stderrFile, "");
    return { exitCode: 0, signal: null, timedOut: false };
  };
}

const DEAD_TOKEN_TRANSCRIPT = transcript([
  initLine(),
  // Exactly what an expired credential leaves behind: one turn, no tokens.
  assistantLine("msg_01", { input_tokens: 0, output_tokens: 0 }),
  resultLine("error_during_execution", true),
]);

const WORKING_TRANSCRIPT = transcript([
  initLine(),
  assistantLine("msg_01", { input_tokens: 900, output_tokens: 120 }, [
    bashCall("toolu_01", "tools/phrasebook greeting fr"),
  ]),
  resultLine(),
]);

function baseOptions(root: string) {
  return {
    n: 5,
    outDir: path.join(root, "runs"),
    credentialsPath: path.join(root, "credentials.json"),
    tmpRoot: root,
    log: () => {},
  };
}

describe("dud guard", () => {
  test(`aborts the batch after ${DUD_GUARD_THRESHOLD} consecutive zero-cost runs`, async () => {
    const root = scratch("dudguard");
    const scenario = makeScenarioDir(root);

    const err = await runBatch(scenario, {
      ...baseOptions(root),
      spawnAgent: fakeAgent(() => DEAD_TOKEN_TRANSCRIPT),
    }).then(
      () => null,
      (e: unknown) => e
    );

    assert.ok(err instanceof DudGuardError, "the batch must not run to completion");
    assert.equal(err.consecutiveDuds, DUD_GUARD_THRESHOLD);
    assert.equal(err.runIds.length, DUD_GUARD_THRESHOLD);
    // The message has to be actionable at 3am, not just true.
    assert.match(err.message, /zero-cost/i);
    assert.match(err.message, /credential/i);
    assert.match(err.message, /mistaken for real failures/i);
  });

  test("the aborted batch records why, and its metrics stay honest", async () => {
    const root = scratch("dudabort");
    const scenario = makeScenarioDir(root);
    const opts = baseOptions(root);

    await runBatch(scenario, {
      ...opts,
      spawnAgent: fakeAgent(() => DEAD_TOKEN_TRANSCRIPT),
    }).catch(() => {});

    const batchDir = path.join(
      opts.outDir,
      fs.readdirSync(opts.outDir)[0] as string
    );
    const batch = JSON.parse(
      fs.readFileSync(path.join(batchDir, "batch.json"), "utf8")
    ) as BatchRecord;

    assert.equal(batch.aborted, true);
    assert.match(String(batch.abortReason), /Dud guard/);
    assert.equal(
      batch.runDirs.length,
      DUD_GUARD_THRESHOLD,
      "it must stop at the threshold, not keep burning runs"
    );

    const m = computeBatchMetrics(batchDir);
    assert.equal(m.aborted, true);
    assert.ok(m.warnings.some((w) => w.includes("ABORTED")));
    // Every run was a dud, so nothing is usable and no rate may be invented.
    assert.equal(m.conditions.with_tool.usable + m.conditions.baseline.usable, 0);
    assert.equal(m.efficacy.baseline.rate, null);
    assert.equal(m.efficacy.withToolAll.rate, null);
    assert.equal(m.efficacy.deltaAllRuns, null);
  });

  test("two duds followed by a working run do not abort the batch", async () => {
    const root = scratch("dudrecover");
    const scenario = makeScenarioDir(root);
    // Fails twice, then recovers — a rate limit, not a dead credential.
    const agent = fakeAgent((n) => (n < 2 ? DEAD_TOKEN_TRANSCRIPT : WORKING_TRANSCRIPT));

    const { batch } = await runBatch(scenario, {
      ...baseOptions(root),
      n: 3,
      spawnAgent: agent,
    });

    assert.equal(batch.aborted, false);
    assert.equal(batch.runDirs.length, 6, "all 3x2 runs should have executed");
  });

  test("the guard counts consecutive duds, not total duds", async () => {
    const root = scratch("dudalternate");
    const scenario = makeScenarioDir(root);
    // Alternating: 4 duds in 8 runs, never 3 in a row.
    const agent = fakeAgent((n) =>
      n % 2 === 0 ? DEAD_TOKEN_TRANSCRIPT : WORKING_TRANSCRIPT
    );

    const { batchDir, batch } = await runBatch(scenario, {
      ...baseOptions(root),
      n: 4,
      spawnAgent: agent,
    });

    assert.equal(batch.aborted, false);
    const m = computeBatchMetrics(batchDir);
    const duds =
      m.conditions.with_tool.excluded.dudZeroCost +
      m.conditions.baseline.excluded.dudZeroCost;
    assert.equal(duds, 4, "the duds are still excluded even though the batch continued");
    assert.ok(m.warnings.some((w) => w.includes("excluded as unusable")));
  });
});

describe("run loop bookkeeping", () => {
  test("conditions are interleaved so drift hits both sides evenly", async () => {
    const root = scratch("interleave");
    const scenario = makeScenarioDir(root);
    const { batch } = await runBatch(scenario, {
      ...baseOptions(root),
      n: 3,
      spawnAgent: fakeAgent(() => WORKING_TRANSCRIPT),
    });
    assert.deepEqual(batch.runDirs.map((d) => path.basename(d)), [
      "with_tool-001",
      "baseline-001",
      "with_tool-002",
      "baseline-002",
      "with_tool-003",
      "baseline-003",
    ]);
  });

  test("the scenario is snapshotted into the batch so metrics survive config edits", async () => {
    const root = scratch("snapshot");
    const scenario = makeScenarioDir(root);
    const { batchDir } = await runBatch(scenario, {
      ...baseOptions(root),
      n: 1,
      spawnAgent: fakeAgent(() => WORKING_TRANSCRIPT),
    });

    // Someone edits the scenario after the batch ran, then deletes it entirely.
    fs.rmSync(scenario.configPath);

    const m = computeBatchMetrics(batchDir);
    assert.equal(m.conditions.with_tool.adoption.rate, 1, "matchers came from the snapshot");
  });
});
