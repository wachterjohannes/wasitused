/**
 * Running a set of scenarios as one batch under a shared budget.
 *
 * The budget is a first-class input, not a backlog item: a full battery is
 * hundreds of runs, and the failure mode is discovering the cost afterwards.
 * It is enforced at two granularities, because either one alone leaks:
 *
 *   - **Per run.** After every finished run the running total is checked, so a
 *     single runaway scenario cannot blow the cap on its own.
 *   - **Per scenario.** Before starting a scenario, its cost is projected from
 *     what runs have cost so far. A scenario that cannot be afforded in full is
 *     skipped rather than started and truncated — half a scenario is not a
 *     cheaper scenario, it is an unusable one.
 *
 * What ran and what was skipped for budget is reported explicitly. Silently
 * running fewer scenarios than asked for is how a suite quietly stops meaning
 * what its name says.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { batchSpend, computeBatchMetrics, type BatchMetrics } from "./metrics";
import { assessPilot, pilotFromBatch, type PilotResult } from "./pilot";
import { COST_CAVEAT } from "./pricing";
import { loadScenario, ScenarioValidationError } from "./scenario";
import { summarize, type Summary } from "./stats";
import { DudGuardError, HARNESS_VERSION, runBatch, type RunBatchOptions } from "./runner";
import type { Condition, ResolvedScenario } from "./types";

export type SuiteMode = "full" | "pilot";

export type EntryStatus =
  | "completed"
  | "budget-stopped"
  | "skipped-budget"
  | "aborted-duds"
  | "failed";

export interface Budget {
  /** Hard cap on list-price-equivalent spend for the whole suite. */
  maxUsd: number | null;
  /** Hard cap on total tokens for the whole suite. */
  maxTokens: number | null;
}

export interface Spend {
  usd: number;
  tokens: number;
  runs: number;
}

export interface SuiteEntry {
  scenarioId: string;
  scenarioConfigPath: string;
  status: EntryStatus;
  /** Why it stopped, was skipped, or failed. null when it simply completed. */
  reason: string | null;
  batchDir: string | null;
  runsPlanned: number;
  runsExecuted: number;
  spend: Spend;
  /** Present for mode "pilot". */
  pilot: PilotResult | null;
}

export interface SuiteRecord {
  schemaVersion: 1;
  suiteId: string;
  mode: SuiteMode;
  n: number;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  budget: Budget;
  spend: Spend;
  budgetExhausted: boolean;
  entries: SuiteEntry[];
  harnessVersion: string;
  costCaveat: string;
}

function emptySpend(): Spend {
  return { usd: 0, tokens: 0, runs: 0 };
}

export function exceedsBudget(spend: Spend, budget: Budget): string | null {
  if (budget.maxUsd !== null && spend.usd > budget.maxUsd) {
    return `suite budget exceeded: $${spend.usd.toFixed(4)} of $${budget.maxUsd.toFixed(
      4
    )} (list-price equivalent)`;
  }
  if (budget.maxTokens !== null && spend.tokens > budget.maxTokens) {
    return `suite token budget exceeded: ${spend.tokens.toLocaleString(
      "en-US"
    )} of ${budget.maxTokens.toLocaleString("en-US")}`;
  }
  return null;
}

/**
 * Can the next scenario be afforded in full?
 *
 * Projected from the mean cost of runs already executed in this suite. With no
 * runs yet there is nothing to project from, so the first scenario always
 * starts — the per-run guard is what protects the cap in that case.
 */
export function projectAffordable(
  spend: Spend,
  budget: Budget,
  runsPlanned: number
): { affordable: boolean; reason: string | null } {
  const already = exceedsBudget(spend, budget);
  if (already) return { affordable: false, reason: already };
  if (spend.runs === 0) return { affordable: true, reason: null };

  const usdPerRun = spend.usd / spend.runs;
  const tokensPerRun = spend.tokens / spend.runs;

  if (budget.maxUsd !== null) {
    const projected = spend.usd + usdPerRun * runsPlanned;
    if (projected > budget.maxUsd) {
      return {
        affordable: false,
        reason:
          `projected $${projected.toFixed(4)} would exceed the $${budget.maxUsd.toFixed(
            4
          )} suite budget ` +
          `($${spend.usd.toFixed(4)} spent, ${runsPlanned} runs x $${usdPerRun.toFixed(
            4
          )}/run projected)`,
      };
    }
  }
  if (budget.maxTokens !== null) {
    const projected = spend.tokens + tokensPerRun * runsPlanned;
    if (projected > budget.maxTokens) {
      return {
        affordable: false,
        reason:
          `projected ${Math.round(projected).toLocaleString("en-US")} tokens would exceed ` +
          `the ${budget.maxTokens.toLocaleString("en-US")} suite budget`,
      };
    }
  }
  return { affordable: true, reason: null };
}

/** Expands a directory of scenarios, or a list of scenario files, into configs. */
export function collectScenarioPaths(targets: string[]): string[] {
  const found: string[] = [];
  for (const target of targets) {
    const abs = path.resolve(target);
    if (!fs.existsSync(abs)) {
      throw new Error(`suite target does not exist: ${abs}`);
    }
    if (fs.statSync(abs).isDirectory()) {
      // A directory is either a scenario itself or a directory of scenarios.
      const own = path.join(abs, "scenario.json");
      if (fs.existsSync(own)) {
        found.push(own);
        continue;
      }
      const children = fs
        .readdirSync(abs)
        .sort()
        .map((name) => path.join(abs, name, "scenario.json"))
        .filter((p) => fs.existsSync(p));
      if (children.length === 0) {
        throw new Error(
          `no scenarios under ${abs} — expected ${abs}/scenario.json or ${abs}/<name>/scenario.json`
        );
      }
      found.push(...children);
    } else {
      found.push(abs);
    }
  }
  if (found.length === 0) throw new Error("suite has no scenarios to run");
  return [...new Set(found)];
}

export interface RunSuiteOptions extends Omit<RunBatchOptions, "conditions" | "onRunComplete"> {
  mode: SuiteMode;
  budget: Budget;
  /** Overridden so tests can drive the loop without spawning agents. */
  runOne?: (
    scenario: ResolvedScenario,
    opts: RunBatchOptions
  ) => Promise<{ batchDir: string }>;
}

export async function runSuite(
  targets: string[],
  opts: RunSuiteOptions
): Promise<{ suiteDir: string; suite: SuiteRecord }> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => new Date());
  const conditions: Condition[] =
    opts.mode === "pilot" ? ["baseline"] : (["with_tool", "baseline"] as Condition[]);
  const runsPerScenario = opts.n * conditions.length;

  const suiteId = `${now().toISOString().replace(/[:.]/g, "-")}-suite`;
  const suiteDir = path.join(opts.outDir, suiteId);
  fs.mkdirSync(suiteDir, { recursive: true });

  const scenarioPaths = collectScenarioPaths(targets);
  const spend = emptySpend();

  const suite: SuiteRecord = {
    schemaVersion: 1,
    suiteId,
    mode: opts.mode,
    n: opts.n,
    model: opts.model ?? null,
    startedAt: now().toISOString(),
    endedAt: null,
    budget: opts.budget,
    spend,
    budgetExhausted: false,
    entries: [],
    harnessVersion: HARNESS_VERSION,
    costCaveat: COST_CAVEAT,
  };
  const write = () =>
    fs.writeFileSync(
      path.join(suiteDir, "suite.json"),
      JSON.stringify(suite, null, 2) + "\n"
    );
  write();

  for (const scenarioPath of scenarioPaths) {
    let scenario: ResolvedScenario;
    try {
      scenario = loadScenario(scenarioPath);
    } catch (err) {
      // One bad config must not cost the other nine scenarios their run.
      suite.entries.push({
        scenarioId: path.basename(path.dirname(scenarioPath)),
        scenarioConfigPath: scenarioPath,
        status: "failed",
        reason:
          err instanceof ScenarioValidationError
            ? err.message
            : String((err as Error).message),
        batchDir: null,
        runsPlanned: runsPerScenario,
        runsExecuted: 0,
        spend: emptySpend(),
        pilot: null,
      });
      log(`${path.basename(path.dirname(scenarioPath))}: FAILED to load — skipping`);
      write();
      continue;
    }

    const affordable = projectAffordable(spend, opts.budget, runsPerScenario);
    if (!affordable.affordable) {
      suite.budgetExhausted = true;
      suite.entries.push({
        scenarioId: scenario.id,
        scenarioConfigPath: scenario.configPath,
        status: "skipped-budget",
        reason: affordable.reason,
        batchDir: null,
        runsPlanned: runsPerScenario,
        runsExecuted: 0,
        spend: emptySpend(),
        pilot: null,
      });
      log(`${scenario.id}: SKIPPED for budget — ${affordable.reason}`);
      write();
      continue;
    }

    log(`${scenario.id}: running ${runsPerScenario} run(s)`);
    const before = { ...spend };
    let batchDir: string | null = null;
    let status: EntryStatus = "completed";
    let reason: string | null = null;

    const batchOpts: RunBatchOptions = {
      ...opts,
      conditions,
      onRunComplete: (progress) => {
        spend.runs += 1;
        spend.tokens += progress.tokens;
        spend.usd += progress.usd ?? 0;
        suite.spend = { ...spend };
        const over = exceedsBudget(spend, opts.budget);
        if (over) {
          suite.budgetExhausted = true;
          return over;
        }
        return null;
      },
    };

    try {
      const result = opts.runOne
        ? await opts.runOne(scenario, batchOpts)
        : await runBatch(scenario, batchOpts);
      batchDir = result.batchDir;
    } catch (err) {
      if (err instanceof DudGuardError) {
        status = "aborted-duds";
        reason = err.message;
        log(`${scenario.id}: ABORTED — dud guard`);
      } else {
        status = "failed";
        reason = String((err as Error).message);
        log(`${scenario.id}: FAILED — ${reason}`);
      }
    }

    let metrics: BatchMetrics | null = null;
    let pilot: PilotResult | null = null;
    if (batchDir) {
      metrics = computeBatchMetrics(batchDir);
      // Recompute spend from the stored artifacts: authoritative, and it also
      // catches anything the live hook missed.
      const actual = batchSpend(metrics);
      spend.usd = before.usd + (actual.usd ?? 0);
      spend.tokens = before.tokens + actual.tokens;
      spend.runs = before.runs + actual.runs;
      suite.spend = { ...spend };

      if (metrics.aborted) {
        status = "aborted-duds";
        reason = metrics.abortReason;
      } else if (actual.runs < runsPerScenario) {
        status = "budget-stopped";
        reason =
          exceedsBudget(spend, opts.budget) ??
          `only ${actual.runs} of ${runsPerScenario} planned runs executed`;
      }
      if (opts.mode === "pilot") {
        pilot = pilotFromBatch(batchDir);
        fs.writeFileSync(
          path.join(batchDir, "pilot.json"),
          JSON.stringify(pilot, null, 2) + "\n"
        );
        log(`${scenario.id}: ${pilot.assessment.verdict.toUpperCase()} — ${pilot.assessment.reason}`);
      }
    }

    suite.entries.push({
      scenarioId: scenario.id,
      scenarioConfigPath: scenario.configPath,
      status,
      reason,
      batchDir,
      runsPlanned: runsPerScenario,
      runsExecuted: metrics ? metrics.runs.length : 0,
      spend: {
        usd: spend.usd - before.usd,
        tokens: spend.tokens - before.tokens,
        runs: spend.runs - before.runs,
      },
      pilot,
    });
    write();
  }

  suite.endedAt = now().toISOString();
  write();
  return { suiteDir, suite };
}

// ---------------------------------------------------------------------------
// Suite-level summary, recomputed from the stored suite + batch artifacts.
// ---------------------------------------------------------------------------

export interface SuiteScenarioSummary {
  scenarioId: string;
  toolRelevant: boolean | null;
  status: EntryStatus;
  reason: string | null;
  runsPlanned: number;
  runsExecuted: number;
  usableRuns: number;
  verdict: string | null;
  baselinePassRate: BatchMetrics["conditions"]["baseline"]["efficacy"]["passRate"] | null;
  withToolPassRate: BatchMetrics["conditions"]["baseline"]["efficacy"]["passRate"] | null;
  adoption: BatchMetrics["conditions"]["baseline"]["adoption"] | null;
  tokensPerRun: Summary;
  usdPerRun: Summary;
  spend: Spend;
  warnings: string[];
}

export interface SuiteSummary {
  schemaVersion: 1;
  suiteId: string;
  mode: SuiteMode;
  n: number;
  model: string | null;
  generatedAt: string;
  budget: Budget;
  spend: Spend;
  budgetExhausted: boolean;
  costCaveat: string;
  scenarios: SuiteScenarioSummary[];
  counts: {
    total: number;
    completed: number;
    budgetStopped: number;
    skippedBudget: number;
    abortedDuds: number;
    failed: number;
    valid: number;
    floor: number;
    ceiling: number;
    indeterminate: number;
  };
  warnings: string[];
}

export function computeSuiteSummary(suiteDir: string): SuiteSummary {
  const suitePath = path.join(suiteDir, "suite.json");
  if (!fs.existsSync(suitePath)) {
    throw new Error(`No readable suite.json in ${suiteDir} — not a wasitused suite directory.`);
  }
  const suite = JSON.parse(fs.readFileSync(suitePath, "utf8")) as SuiteRecord;

  const scenarios: SuiteScenarioSummary[] = suite.entries.map((entry) => {
    if (!entry.batchDir || !fs.existsSync(path.join(entry.batchDir, "batch.json"))) {
      return {
        scenarioId: entry.scenarioId,
        toolRelevant: null,
        status: entry.status,
        reason: entry.reason,
        runsPlanned: entry.runsPlanned,
        runsExecuted: entry.runsExecuted,
        usableRuns: 0,
        verdict: null,
        baselinePassRate: null,
        withToolPassRate: null,
        adoption: null,
        tokensPerRun: summarize([]),
        usdPerRun: summarize([]),
        spend: entry.spend,
        warnings: [],
      };
    }
    const m = computeBatchMetrics(entry.batchDir);
    const usable = m.runs.filter((r) => r.usable);
    const verdict =
      suite.mode === "pilot"
        ? assessPilot(m.conditions.baseline.efficacy.passRate).verdict
        : null;
    return {
      scenarioId: entry.scenarioId,
      toolRelevant: m.toolRelevant,
      status: entry.status,
      reason: entry.reason,
      runsPlanned: entry.runsPlanned,
      runsExecuted: m.runs.length,
      usableRuns: usable.length,
      verdict,
      baselinePassRate: m.conditions.baseline.efficacy.passRate,
      withToolPassRate:
        m.conditions.with_tool.runsAttempted > 0
          ? m.conditions.with_tool.efficacy.passRate
          : null,
      adoption:
        m.conditions.with_tool.runsAttempted > 0 ? m.conditions.with_tool.adoption : null,
      tokensPerRun: summarize(usable.map((r) => r.tokens.total)),
      usdPerRun: summarize(
        usable.map((r) => r.usdListEquivalent).filter((v): v is number => v !== null)
      ),
      spend: entry.spend,
      warnings: m.warnings,
    };
  });

  const countStatus = (s: EntryStatus) =>
    scenarios.filter((x) => x.status === s).length;
  const countVerdict = (v: string) => scenarios.filter((x) => x.verdict === v).length;

  const warnings: string[] = [];
  if (suite.budgetExhausted) {
    const skipped = countStatus("skipped-budget") + countStatus("budget-stopped");
    warnings.push(
      `The suite budget was exhausted: ${skipped} scenario(s) were skipped or cut short. ` +
        "The scenarios that did run are complete, but this suite does not cover everything " +
        "it was asked to cover — do not read it as a full sweep."
    );
  }
  if (countStatus("failed") > 0) {
    warnings.push(
      `${countStatus("failed")} scenario(s) failed to run at all and produced no data.`
    );
  }
  if (countStatus("aborted-duds") > 0) {
    warnings.push(
      `${countStatus("aborted-duds")} scenario(s) were aborted by the dud guard — ` +
        "check credentials before trusting anything else in this suite."
    );
  }
  if (suite.n < 20 && suite.mode === "full") {
    warnings.push(
      `N=${suite.n} per condition. Pilot scale — enough to gate scenarios, not to publish.`
    );
  }

  return {
    schemaVersion: 1,
    suiteId: suite.suiteId,
    mode: suite.mode,
    n: suite.n,
    model: suite.model,
    generatedAt: new Date().toISOString(),
    budget: suite.budget,
    spend: suite.spend,
    budgetExhausted: suite.budgetExhausted,
    costCaveat: suite.costCaveat,
    scenarios,
    counts: {
      total: scenarios.length,
      completed: countStatus("completed"),
      budgetStopped: countStatus("budget-stopped"),
      skippedBudget: countStatus("skipped-budget"),
      abortedDuds: countStatus("aborted-duds"),
      failed: countStatus("failed"),
      valid: countVerdict("valid"),
      floor: countVerdict("floor"),
      ceiling: countVerdict("ceiling"),
      indeterminate: countVerdict("indeterminate"),
    },
    warnings,
  };
}
