/**
 * Suite running and the shared budget.
 *
 * The failure mode a budget exists to prevent is discovering the cost after the
 * fact. The failure mode a *badly implemented* budget introduces is worse: a
 * suite that quietly runs six of ten scenarios and reports as if it ran ten.
 * These tests pin both — the cap is enforced, and what did not run is named.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { test, describe, after } from "node:test";
import {
  collectScenarioPaths,
  computeSuiteSummary,
  exceedsBudget,
  projectAffordable,
  runSuite,
  type Budget,
} from "../src/suite";
import type { SpawnAgentFn } from "../src/runner";
import {
  assistantLine,
  initLine,
  makeScenarioDir,
  resultLine,
  scenarioConfig,
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

/**
 * Builds N sibling scenario directories that all share one tool directory,
 * mirroring how the bundled examples are laid out.
 */
function makeScenarioSet(root: string, ids: string[]): string {
  const suiteRoot = path.join(root, "scenarios");
  const toolRoot = path.join(suiteRoot, "phrasebook-tool");
  fs.mkdirSync(path.join(toolRoot, "skills", "phrasebook"), { recursive: true });
  fs.writeFileSync(path.join(toolRoot, "skills", "phrasebook", "SKILL.md"), "# phrasebook\n");
  fs.mkdirSync(path.join(toolRoot, "tools"), { recursive: true });
  fs.writeFileSync(path.join(toolRoot, "tools", "phrasebook"), "#!/bin/sh\nexit 0\n");

  for (const id of ids) {
    const dir = path.join(suiteRoot, id);
    fs.mkdirSync(path.join(dir, "fixture"), { recursive: true });
    fs.writeFileSync(path.join(dir, "fixture", "app.txt"), "original\n");
    fs.writeFileSync(
      path.join(dir, "scenario.json"),
      JSON.stringify(
        scenarioConfig({
          id,
          check: { command: "grep -q solved app.txt", timeoutMs: 5000 },
        }),
        null,
        2
      )
    );
  }
  return suiteRoot;
}

/** One run = `tokens` tokens and `usd` dollars, deterministically. */
function fixedCostAgent(tokens: number, usd: number, solved = false): SpawnAgentFn {
  return async (req) => {
    fs.writeFileSync(
      req.transcriptFile,
      transcript([
        initLine(),
        assistantLine("msg_01", { input_tokens: tokens, output_tokens: 10 }),
        resultLine("success", false, { input_tokens: tokens, output_tokens: 10 }, usd),
      ])
    );
    fs.writeFileSync(req.stderrFile, "");
    fs.writeFileSync(path.join(req.cwd, "app.txt"), solved ? "solved\n" : "original\n");
    return { exitCode: 0, signal: null, timedOut: false };
  };
}

function baseOpts(root: string) {
  return {
    outDir: path.join(root, "runs"),
    credential: { kind: "file" as const, path: path.join(root, "credentials.json") },
    tmpRoot: root,
    log: () => {},
  };
}

const NO_BUDGET: Budget = { maxUsd: null, maxTokens: null };

describe("collecting scenarios", () => {
  test("a directory of scenario directories expands to all of them", () => {
    const root = scratch("collect-dir");
    const suiteRoot = makeScenarioSet(root, ["alpha", "beta", "gamma"]);
    const found = collectScenarioPaths([suiteRoot]);
    assert.equal(found.length, 3);
    assert.deepEqual(
      found.map((f) => path.basename(path.dirname(f))),
      ["alpha", "beta", "gamma"],
      "order must be stable so a suite is reproducible"
    );
  });

  test("a single scenario directory resolves to its own config", () => {
    const root = scratch("collect-one");
    const suiteRoot = makeScenarioSet(root, ["alpha"]);
    const found = collectScenarioPaths([path.join(suiteRoot, "alpha")]);
    assert.equal(found.length, 1);
    assert.ok(found[0]?.endsWith(path.join("alpha", "scenario.json")));
  });

  test("explicit files are accepted and de-duplicated", () => {
    const root = scratch("collect-files");
    const suiteRoot = makeScenarioSet(root, ["alpha", "beta"]);
    const a = path.join(suiteRoot, "alpha", "scenario.json");
    const found = collectScenarioPaths([a, a, path.join(suiteRoot, "beta", "scenario.json")]);
    assert.equal(found.length, 2);
  });

  test("a missing target is an error, not an empty suite", () => {
    assert.throws(
      () => collectScenarioPaths(["/nonexistent/scenarios"]),
      /does not exist/
    );
  });

  test("a directory with no scenarios is an error, not an empty suite", () => {
    const root = scratch("collect-empty");
    fs.mkdirSync(path.join(root, "empty"), { recursive: true });
    assert.throws(() => collectScenarioPaths([path.join(root, "empty")]), /no scenarios under/);
  });
});

describe("budget arithmetic", () => {
  test("no budget never blocks anything", () => {
    assert.equal(exceedsBudget({ usd: 1e9, tokens: 1e12, runs: 5 }, NO_BUDGET), null);
    assert.equal(
      projectAffordable({ usd: 1e9, tokens: 1e12, runs: 5 }, NO_BUDGET, 100).affordable,
      true
    );
  });

  test("the cap is a cap, not a target", () => {
    const budget: Budget = { maxUsd: 1, maxTokens: null };
    assert.equal(exceedsBudget({ usd: 1, tokens: 0, runs: 1 }, budget), null, "exactly at the cap is fine");
    assert.match(String(exceedsBudget({ usd: 1.0001, tokens: 0, runs: 1 }, budget)), /budget exceeded/);
  });

  test("the first scenario always starts — there is nothing to project from yet", () => {
    const budget: Budget = { maxUsd: 0.01, maxTokens: null };
    const p = projectAffordable({ usd: 0, tokens: 0, runs: 0 }, budget, 100);
    assert.equal(p.affordable, true, "the per-run guard protects the cap before any data exists");
  });

  test("a scenario that cannot be afforded in full is refused up front", () => {
    // $0.10/run observed, 10 runs planned, $0.50 left → $1.10 projected.
    const budget: Budget = { maxUsd: 0.6, maxTokens: null };
    const p = projectAffordable({ usd: 0.1, tokens: 1000, runs: 1 }, budget, 10);
    assert.equal(p.affordable, false);
    assert.match(String(p.reason), /projected/);
    assert.match(String(p.reason), /would exceed/);
  });

  test("token budgets project the same way", () => {
    const budget: Budget = { maxUsd: null, maxTokens: 10_000 };
    assert.equal(projectAffordable({ usd: 0, tokens: 1000, runs: 1 }, budget, 5).affordable, true);
    assert.equal(projectAffordable({ usd: 0, tokens: 1000, runs: 1 }, budget, 50).affordable, false);
  });
});

describe("running a suite", () => {
  test("every scenario runs when the budget is ample, and spend is accounted", async () => {
    const root = scratch("suite-full");
    const suiteRoot = makeScenarioSet(root, ["alpha", "beta"]);

    const { suiteDir, suite } = await runSuite([suiteRoot], {
      ...baseOpts(root),
      mode: "full",
      n: 2,
      budget: NO_BUDGET,
      spawnAgent: fixedCostAgent(1000, 0.05),
    });

    assert.equal(suite.entries.length, 2);
    assert.ok(suite.entries.every((e) => e.status === "completed"));
    // 2 scenarios x 2 conditions x n=2 = 8 runs.
    assert.equal(suite.spend.runs, 8);
    assert.ok(Math.abs(suite.spend.usd - 8 * 0.05) < 1e-9);
    assert.equal(suite.budgetExhausted, false);

    const summary = computeSuiteSummary(suiteDir);
    assert.equal(summary.counts.completed, 2);
    assert.equal(summary.counts.skippedBudget, 0);
  });

  test("a budget stops the suite and names what did not run", async () => {
    const root = scratch("suite-budget");
    const suiteRoot = makeScenarioSet(root, ["alpha", "beta", "gamma", "delta"]);

    // $0.10/run, 4 runs per scenario = $0.40 per scenario. A $0.55 cap affords
    // the first scenario and then must refuse the rest.
    const { suiteDir, suite } = await runSuite([suiteRoot], {
      ...baseOpts(root),
      mode: "full",
      n: 2,
      budget: { maxUsd: 0.55, maxTokens: null },
      spawnAgent: fixedCostAgent(1000, 0.1),
    });

    const byId = Object.fromEntries(suite.entries.map((e) => [e.scenarioId, e]));
    assert.equal(byId.alpha?.status, "completed");
    assert.equal(byId.beta?.status, "skipped-budget");
    assert.equal(byId.gamma?.status, "skipped-budget");
    assert.equal(byId.delta?.status, "skipped-budget");
    assert.match(String(byId.beta?.reason), /budget/i);
    assert.equal(suite.budgetExhausted, true);

    // The cap held.
    assert.ok(suite.spend.usd <= 0.55 + 1e-9, `spent ${suite.spend.usd}`);

    const summary = computeSuiteSummary(suiteDir);
    assert.equal(summary.counts.completed, 1);
    assert.equal(summary.counts.skippedBudget, 3);
    assert.ok(
      summary.warnings.some((w) => w.includes("do not read it as a full sweep")),
      "a partial suite must say it is partial"
    );
  });

  test("a runaway scenario is cut off mid-batch by the per-run guard", async () => {
    const root = scratch("suite-perrun");
    const suiteRoot = makeScenarioSet(root, ["alpha"]);

    // 10 runs planned at $0.10 each, but only $0.25 of budget: the projection
    // cannot help (no prior data), so the per-run guard has to stop it.
    const { suiteDir, suite } = await runSuite([suiteRoot], {
      ...baseOpts(root),
      mode: "full",
      n: 5,
      budget: { maxUsd: 0.25, maxTokens: null },
      spawnAgent: fixedCostAgent(1000, 0.1),
    });

    const entry = suite.entries[0];
    assert.ok(entry);
    assert.equal(entry.status, "budget-stopped");
    assert.ok(entry.runsExecuted < entry.runsPlanned, "it must not have run to completion");
    assert.equal(entry.runsExecuted, 3, "stops on the run that crosses the cap");
    assert.ok(suite.spend.usd <= 0.35 + 1e-9);

    const summary = computeSuiteSummary(suiteDir);
    assert.equal(summary.counts.budgetStopped, 1);
    assert.ok(summary.scenarios[0]?.reason);
  });

  test("token budgets are enforced too", async () => {
    const root = scratch("suite-tokens");
    const suiteRoot = makeScenarioSet(root, ["alpha", "beta"]);
    const { suite } = await runSuite([suiteRoot], {
      ...baseOpts(root),
      mode: "full",
      n: 2,
      budget: { maxUsd: null, maxTokens: 5000 },
      spawnAgent: fixedCostAgent(1010, 0.01),
    });
    assert.equal(suite.budgetExhausted, true);
    assert.ok(suite.spend.tokens <= 5000 + 1020, `spent ${suite.spend.tokens} tokens`);
  });

  test("one broken config does not cost the other scenarios their run", async () => {
    const root = scratch("suite-broken");
    const suiteRoot = makeScenarioSet(root, ["alpha", "broken", "gamma"]);
    // A misspelled key — exactly what strict validation is there to catch.
    fs.writeFileSync(
      path.join(suiteRoot, "broken", "scenario.json"),
      JSON.stringify({ ...scenarioConfig({ id: "broken" }), toolRelevent: true })
    );

    const { suiteDir, suite } = await runSuite([suiteRoot], {
      ...baseOpts(root),
      mode: "full",
      n: 1,
      budget: NO_BUDGET,
      spawnAgent: fixedCostAgent(1000, 0.01),
    });

    const byId = Object.fromEntries(suite.entries.map((e) => [e.scenarioId, e]));
    assert.equal(byId.broken?.status, "failed");
    assert.match(String(byId.broken?.reason), /unknown field "toolRelevent"/);
    assert.equal(byId.alpha?.status, "completed");
    assert.equal(byId.gamma?.status, "completed");

    const summary = computeSuiteSummary(suiteDir);
    assert.equal(summary.counts.failed, 1);
    assert.equal(summary.counts.completed, 2);
    assert.ok(summary.warnings.some((w) => w.includes("failed to run at all")));
  });

  test("a dud-guard abort in one scenario does not sink the suite", async () => {
    const root = scratch("suite-duds");
    const suiteRoot = makeScenarioSet(root, ["alpha", "beta"]);

    let call = 0;
    const agent: SpawnAgentFn = async (req) => {
      // The first scenario's runs are all duds; later ones are healthy.
      const dud = call < 4;
      call++;
      fs.writeFileSync(
        req.transcriptFile,
        dud
          ? transcript([
              initLine(),
              assistantLine("msg_01", { input_tokens: 0, output_tokens: 0 }),
              resultLine("error_during_execution", true),
            ])
          : transcript([
              initLine(),
              assistantLine("msg_01", { input_tokens: 1000, output_tokens: 10 }),
              resultLine("success", false, { input_tokens: 1000, output_tokens: 10 }, 0.01),
            ])
      );
      fs.writeFileSync(req.stderrFile, "");
      return { exitCode: 0, signal: null, timedOut: false };
    };

    const { suiteDir, suite } = await runSuite([suiteRoot], {
      ...baseOpts(root),
      mode: "full",
      n: 2,
      budget: NO_BUDGET,
      spawnAgent: agent,
    });

    const byId = Object.fromEntries(suite.entries.map((e) => [e.scenarioId, e]));
    assert.equal(byId.alpha?.status, "aborted-duds");
    assert.equal(byId.beta?.status, "completed");

    const summary = computeSuiteSummary(suiteDir);
    assert.equal(summary.counts.abortedDuds, 1);
    assert.ok(summary.warnings.some((w) => w.includes("check credentials")));
  });
});

describe("suite in pilot mode", () => {
  test("runs baseline only and gates every scenario", async () => {
    const root = scratch("suite-pilot");
    const suiteRoot = makeScenarioSet(root, ["always", "never"]);

    // "always" solves every run (ceiling); "never" solves none (floor).
    const agent: SpawnAgentFn = async (req) => {
      const solved = req.cwd.includes("always");
      fs.writeFileSync(
        req.transcriptFile,
        transcript([
          initLine(),
          assistantLine("msg_01", { input_tokens: 1000, output_tokens: 10 }),
          resultLine("success", false, { input_tokens: 1000, output_tokens: 10 }, 0.01),
        ])
      );
      fs.writeFileSync(req.stderrFile, "");
      fs.writeFileSync(path.join(req.cwd, "app.txt"), solved ? "solved\n" : "original\n");
      return { exitCode: 0, signal: null, timedOut: false };
    };

    const { suiteDir, suite } = await runSuite([suiteRoot], {
      ...baseOpts(root),
      mode: "pilot",
      n: 4,
      budget: NO_BUDGET,
      spawnAgent: agent,
    });

    assert.equal(suite.spend.runs, 8, "2 scenarios x 4 baseline runs — no with-tool arm");
    const byId = Object.fromEntries(suite.entries.map((e) => [e.scenarioId, e]));
    assert.equal(byId.always?.pilot?.assessment.verdict, "ceiling");
    assert.equal(byId.never?.pilot?.assessment.verdict, "floor");

    const summary = computeSuiteSummary(suiteDir);
    assert.equal(summary.mode, "pilot");
    assert.equal(summary.counts.ceiling, 1);
    assert.equal(summary.counts.floor, 1);
    assert.equal(summary.counts.valid, 0);
    assert.equal(summary.scenarios[0]?.withToolPassRate, null, "no with-tool arm to report");
  });

  test("the summary recomputes from disk without re-running", async () => {
    const root = scratch("suite-recompute");
    const suiteRoot = makeScenarioSet(root, ["alpha"]);
    const { suiteDir } = await runSuite([suiteRoot], {
      ...baseOpts(root),
      mode: "pilot",
      n: 2,
      budget: NO_BUDGET,
      spawnAgent: fixedCostAgent(1000, 0.01),
    });

    const a = computeSuiteSummary(suiteDir);
    const b = computeSuiteSummary(suiteDir);
    assert.deepEqual({ ...a, generatedAt: null }, { ...b, generatedAt: null });
  });

  test("a directory that is not a suite is rejected clearly", () => {
    const root = scratch("suite-notasuite");
    assert.throws(() => computeSuiteSummary(root), /not a wasitused suite directory/);
  });
});

describe("variance reporting", () => {
  test("per-scenario token spread is summarised across the runs", async () => {
    const root = scratch("suite-variance");
    const suiteRoot = makeScenarioSet(root, ["alpha"]);

    let i = 0;
    const varying: SpawnAgentFn = async (req) => {
      const tokens = [1000, 2000, 3000, 4000][i % 4] as number;
      i++;
      fs.writeFileSync(
        req.transcriptFile,
        transcript([
          initLine(),
          assistantLine("msg_01", { input_tokens: tokens, output_tokens: 10 }),
          resultLine("success", false, { input_tokens: tokens, output_tokens: 10 }, 0.01),
        ])
      );
      fs.writeFileSync(req.stderrFile, "");
      return { exitCode: 0, signal: null, timedOut: false };
    };

    const { suiteDir } = await runSuite([suiteRoot], {
      ...baseOpts(root),
      mode: "pilot",
      n: 4,
      budget: NO_BUDGET,
      spawnAgent: varying,
    });

    const summary = computeSuiteSummary(suiteDir);
    const tokens = summary.scenarios[0]?.tokensPerRun;
    assert.ok(tokens);
    assert.equal(tokens.n, 4);
    assert.equal(tokens.mean, 2510); // (1010+2010+3010+4010)/4
    assert.ok(tokens.sd !== null && tokens.sd > 0);
    assert.ok(tokens.sem !== null, "a mean without a standard error is not reportable");
    assert.ok(tokens.ci95 !== null);
    assert.ok(
      (tokens.ci95 as [number, number])[0] < 2510 &&
        (tokens.ci95 as [number, number])[1] > 2510
    );
  });
});
