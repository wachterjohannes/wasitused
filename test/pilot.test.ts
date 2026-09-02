/**
 * The pilot gate.
 *
 * The verdict is a pure function of a measured pass rate, so the boundaries and
 * the failure modes are pinned here without spending a run. The one that
 * matters most: an unmeasurable pass rate must come out as `indeterminate`, not
 * as `floor`. Calling a broken check "too hard" invents a finding out of
 * infrastructure failure, and it is the reading that costs you a scenario you
 * should have kept.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { test, describe, after } from "node:test";
import { assessPilot, PILOT_EXIT, pilotFromBatch, runPilot } from "../src/pilot";
import { rate } from "../src/stats";
import type { SpawnAgentFn } from "../src/runner";
import {
  assistantLine,
  bashCall,
  initLine,
  makeBatchDir,
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

describe("gate boundaries", () => {
  const cases: Array<[number, number, string]> = [
    [0, 10, "floor"],
    [1, 10, "floor"],
    [2, 10, "valid"], // exactly 20% is inside the band
    [5, 10, "valid"],
    [8, 10, "valid"], // exactly 80% is inside the band
    [9, 10, "ceiling"],
    [10, 10, "ceiling"],
  ];

  for (const [k, n, expected] of cases) {
    test(`${k}/${n} is ${expected}`, () => {
      assert.equal(assessPilot(rate(k, n)).verdict, expected);
    });
  }

  test("the band is inclusive at both ends, not exclusive", () => {
    // 0.2 and 0.8 exactly — the off-by-one that quietly cuts good scenarios.
    assert.equal(assessPilot(rate(1, 5)).verdict, "valid");
    assert.equal(assessPilot(rate(4, 5)).verdict, "valid");
  });

  test("every verdict carries a reason and a recommendation", () => {
    for (const [k, n] of cases) {
      const a = assessPilot(rate(k, n));
      assert.ok(a.reason.length > 20, `${k}/${n} reason too thin`);
      assert.ok(a.recommendation.length > 20, `${k}/${n} recommendation too thin`);
      assert.ok(a.reason.includes(`${k}/${n}`), "the reason must show the raw counts");
    }
  });
});

describe("unmeasurable is not the same as hard", () => {
  test("zero usable runs is indeterminate, not a floor", () => {
    const a = assessPilot(rate(0, 0));
    assert.equal(a.verdict, "indeterminate");
    assert.notEqual(a.verdict, "floor");
    assert.match(a.reason, /could not be measured/i);
    assert.match(a.recommendation, /not a hard scenario/i);
  });

  test("a failing gate exits non-zero, a passing one exits zero", () => {
    assert.equal(PILOT_EXIT.valid, 0);
    assert.ok(PILOT_EXIT.floor > 0);
    assert.ok(PILOT_EXIT.ceiling > 0);
    assert.ok(PILOT_EXIT.indeterminate > 0);
    // Distinct, so a script can tell why it failed.
    const codes = Object.values(PILOT_EXIT);
    assert.equal(new Set(codes).size, codes.length);
  });
});

// A baseline run that produced real tokens and did or did not solve the task.
function baselineRun(solved: boolean | null, tokens = 1000): string {
  return transcript([
    initLine(),
    assistantLine("msg_01", { input_tokens: tokens, output_tokens: 50 }),
    resultLine("success", false, { input_tokens: tokens, output_tokens: 50 }, 0.01),
  ]);
}

function zeroCostRun(): string {
  return transcript([
    initLine(),
    assistantLine("msg_01", { input_tokens: 0, output_tokens: 0 }),
    resultLine("error_during_execution", true),
  ]);
}

describe("pilotFromBatch", () => {
  test("derives the verdict from stored baseline runs alone", () => {
    const dir = scratch("pilot-from-batch");
    const batchDir = makeBatchDir(
      dir,
      [
        { condition: "baseline", index: 1, transcript: baselineRun(true), check: { solved: true } },
        { condition: "baseline", index: 2, transcript: baselineRun(false), check: { solved: false } },
        { condition: "baseline", index: 3, transcript: baselineRun(false), check: { solved: false } },
        { condition: "baseline", index: 4, transcript: baselineRun(false), check: { solved: false } },
        { condition: "baseline", index: 5, transcript: baselineRun(false), check: { solved: false } },
      ],
      { n: 5 }
    );

    const result = pilotFromBatch(batchDir);
    assert.equal(result.passRate.k, 1);
    assert.equal(result.passRate.n, 5);
    assert.equal(result.assessment.verdict, "valid"); // 20%, the lower edge
    assert.equal(result.baselineInvocations, 0);
    assert.ok(result.spend.tokens > 0, "spend must be accounted even in a pilot");
  });

  test("a dud does not push a scenario into the floor", () => {
    const dir = scratch("pilot-dud");
    // 2 passes, 2 fails, 1 dud. Counting the dud as a failure gives 2/5 = 40%
    // (still valid here) but the denominator must be 4, not 5.
    const batchDir = makeBatchDir(
      dir,
      [
        { condition: "baseline", index: 1, transcript: baselineRun(true), check: { solved: true } },
        { condition: "baseline", index: 2, transcript: baselineRun(true), check: { solved: true } },
        { condition: "baseline", index: 3, transcript: baselineRun(false), check: { solved: false } },
        { condition: "baseline", index: 4, transcript: baselineRun(false), check: { solved: false } },
        { condition: "baseline", index: 5, transcript: zeroCostRun(), check: { solved: false } },
      ],
      { n: 5 }
    );

    const result = pilotFromBatch(batchDir);
    assert.equal(result.usableRuns, 4);
    assert.equal(result.excluded.dudZeroCost, 1);
    assert.equal(result.passRate.n, 4, "the dud must leave the denominator");
    assert.equal(result.passRate.rate, 0.5);
    assert.equal(result.assessment.verdict, "valid");
  });

  test("all-indeterminate checks give indeterminate, never floor", () => {
    const dir = scratch("pilot-indet");
    const batchDir = makeBatchDir(
      dir,
      [1, 2, 3].map((i) => ({
        condition: "baseline" as const,
        index: i,
        transcript: baselineRun(null),
        check: { solved: null, reason: "check timed out" },
      })),
      { n: 3 }
    );

    const result = pilotFromBatch(batchDir);
    assert.equal(result.indeterminateChecks, 3);
    assert.equal(result.assessment.verdict, "indeterminate");
  });

  test("an over-use probe is flagged as exempt from the gate", () => {
    const dir = scratch("pilot-irrelevant");
    const batchDir = makeBatchDir(
      dir,
      [
        { condition: "baseline", index: 1, transcript: baselineRun(true), check: { solved: true } },
        { condition: "baseline", index: 2, transcript: baselineRun(true), check: { solved: true } },
      ],
      { n: 2 },
      { toolRelevant: false }
    );

    const result = pilotFromBatch(batchDir);
    assert.equal(result.assessment.verdict, "ceiling");
    assert.ok(
      result.warnings.some((w) => w.includes("exempt from the")),
      "a ceiling on a tool-irrelevant probe is expected, and must be said so"
    );
  });

  test("stray with-tool runs are called out and excluded from the verdict", () => {
    const dir = scratch("pilot-stray");
    const batchDir = makeBatchDir(
      dir,
      [
        { condition: "baseline", index: 1, transcript: baselineRun(false), check: { solved: false } },
        { condition: "baseline", index: 2, transcript: baselineRun(false), check: { solved: false } },
        // Someone piloted a directory that already had a full batch in it.
        { condition: "with_tool", index: 1, transcript: baselineRun(true), check: { solved: true } },
        { condition: "with_tool", index: 2, transcript: baselineRun(true), check: { solved: true } },
      ],
      { n: 2 }
    );

    const result = pilotFromBatch(batchDir);
    assert.equal(result.passRate.n, 2, "only the baseline arm gates the scenario");
    assert.equal(result.assessment.verdict, "floor");
    assert.ok(result.warnings.some((w) => w.includes("supposed to be baseline-only")));
  });
});

describe("runPilot", () => {
  function fakeAgent(solvedPattern: boolean[]): SpawnAgentFn {
    let i = 0;
    return async (req) => {
      const solved = solvedPattern[i % solvedPattern.length];
      i++;
      fs.writeFileSync(
        req.transcriptFile,
        transcript([
          initLine(),
          assistantLine("msg_01", { input_tokens: 1000, output_tokens: 50 }),
          resultLine("success", false, { input_tokens: 1000, output_tokens: 50 }, 0.01),
        ])
      );
      fs.writeFileSync(req.stderrFile, "");
      // The check reads the artifact, so encode the outcome into the workspace.
      fs.writeFileSync(path.join(req.cwd, "app.txt"), solved ? "solved\n" : "original\n");
      return { exitCode: 0, signal: null, timedOut: false };
    };
  }

  function scenarioWithCheck(root: string) {
    return makeScenarioDir(root, {
      // Solved iff the agent wrote "solved" into the artifact.
      check: { command: 'grep -q solved app.txt', timeoutMs: 5000 },
    });
  }

  test("runs the baseline only — the tool is never made available", async () => {
    const root = scratch("runpilot-baseline");
    const scenario = scenarioWithCheck(root);

    const result = await runPilot(scenario, {
      n: 4,
      outDir: path.join(root, "runs"),
      credential: { kind: "file" as const, path: path.join(root, "credentials.json") },
      tmpRoot: root,
      spawnAgent: fakeAgent([true, false, false, false]),
      log: () => {},
    });

    const batch = JSON.parse(
      fs.readFileSync(path.join(result.batchDir, "batch.json"), "utf8")
    ) as { runDirs: string[]; conditions: string[] };
    assert.deepEqual(batch.conditions, ["baseline"]);
    assert.equal(batch.runDirs.length, 4, "4 runs, not 8 — one condition only");
    assert.ok(
      batch.runDirs.every((d) => path.basename(d).startsWith("baseline")),
      "a pilot must not spend runs on the with-tool arm"
    );
    assert.equal(result.passRate.k, 1);
    assert.equal(result.passRate.n, 4);
    assert.equal(result.assessment.verdict, "valid"); // 25%
  });

  test("writes pilot.json and reproduces the verdict from disk without re-running", async () => {
    const root = scratch("runpilot-recompute");
    const scenario = scenarioWithCheck(root);

    const result = await runPilot(scenario, {
      n: 3,
      outDir: path.join(root, "runs"),
      credential: { kind: "file" as const, path: path.join(root, "credentials.json") },
      tmpRoot: root,
      spawnAgent: fakeAgent([false]),
      log: () => {},
    });

    assert.ok(fs.existsSync(path.join(result.batchDir, "pilot.json")));
    assert.equal(result.assessment.verdict, "floor"); // 0/3

    const again = pilotFromBatch(result.batchDir);
    assert.equal(again.assessment.verdict, result.assessment.verdict);
    assert.deepEqual(again.passRate, result.passRate);
  });
});
