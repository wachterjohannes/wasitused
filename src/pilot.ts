/**
 * Scenario piloting: the gate a scenario has to pass before it is worth
 * spending a real batch on.
 *
 * A pilot runs the BASELINE ONLY — the tool is never made available. The
 * question is not "does the tool help", it is "is there any room for it to".
 * A task the agent already always passes has no lever for a tool to move; a
 * task it never passes has nothing to improve. Either way the scenario cannot
 * produce a measurable effect, and running the full battery on it spends the
 * whole budget to learn nothing.
 *
 * The verdict is a pure function of a measured pass rate, so the boundary
 * behaviour is testable without spending a single run.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { batchSpend, computeBatchMetrics } from "./metrics";
import { runBatch, type RunBatchOptions } from "./runner";
import type { Rate } from "./stats";
import type { ResolvedScenario } from "./types";

export type PilotVerdict = "valid" | "floor" | "ceiling" | "indeterminate";

/** The usable band from METHODOLOGY.md, inclusive at both ends. */
export const PILOT_GATE = { floorBelow: 0.2, ceilingAbove: 0.8 } as const;

/**
 * Exit codes, kept distinct so a pilot is scriptable.
 * 0 valid · 3 floor · 4 ceiling · 5 indeterminate.
 * (1 stays generic error and 2 stays dud-guard abort, as in `run`.)
 */
export const PILOT_EXIT: Record<PilotVerdict, number> = {
  valid: 0,
  floor: 3,
  ceiling: 4,
  indeterminate: 5,
};

export interface PilotAssessment {
  verdict: PilotVerdict;
  reason: string;
  recommendation: string;
  gate: { floorBelow: number; ceilingAbove: number };
}

function fmt(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

/**
 * Applies the gate to a measured baseline pass rate.
 *
 * `indeterminate` is a distinct outcome from `floor`, deliberately: a scenario
 * whose check never returned a determinate answer has not been measured at all,
 * and calling that "too hard" would invent a finding out of a broken check.
 */
export function assessPilot(passRate: Rate): PilotAssessment {
  const gate = { floorBelow: PILOT_GATE.floorBelow, ceilingAbove: PILOT_GATE.ceilingAbove };

  if (passRate.rate === null) {
    return {
      verdict: "indeterminate",
      reason:
        passRate.n === 0
          ? "No usable baseline runs — the pass rate could not be measured at all."
          : "No determinate baseline runs — every check returned solved: null.",
      recommendation:
        "Fix the harness or the success check before gating this scenario. " +
        "An unmeasured scenario is not a hard scenario.",
      gate,
    };
  }

  const observed = `Baseline passed ${passRate.k}/${passRate.n} (${fmt(passRate.rate)})`;
  const ci = passRate.ci95
    ? `, 95% CI ${fmt(passRate.ci95[0])}-${fmt(passRate.ci95[1])}`
    : "";

  if (passRate.rate < gate.floorBelow) {
    return {
      verdict: "floor",
      reason: `${observed}${ci} — below the ${fmt(gate.floorBelow)} floor.`,
      recommendation:
        "The task is too hard: there is almost nothing for the tool to improve, " +
        "so an effect cannot show up. Make the task easier or narrower, or cut it.",
      gate,
    };
  }

  if (passRate.rate > gate.ceilingAbove) {
    return {
      verdict: "ceiling",
      reason: `${observed}${ci} — above the ${fmt(gate.ceilingAbove)} ceiling.`,
      recommendation:
        "The task is too easy: the agent already solves it unaided, so the tool " +
        "has no lever. Make the task harder, or keep it only as a tool-irrelevant " +
        "over-use probe (toolRelevant: false), which is exempt from this gate.",
      gate,
    };
  }

  return {
    verdict: "valid",
    reason: `${observed}${ci} — inside the ${fmt(gate.floorBelow)}-${fmt(
      gate.ceilingAbove
    )} band.`,
    recommendation:
      "There is room for the tool to move the outcome. This scenario can enter the suite.",
    gate,
  };
}

export interface PilotResult {
  schemaVersion: 1;
  scenarioId: string;
  toolRelevant: boolean;
  model: string;
  n: number;
  batchId: string;
  batchDir: string;
  runsAttempted: number;
  usableRuns: number;
  excluded: { dudZeroCost: number; unparseableTranscript: number; missingRunRecord: number };
  indeterminateChecks: number;
  passRate: Rate;
  assessment: PilotAssessment;
  /** Present but expected to be 0: the tool is not available in a pilot. */
  baselineInvocations: number;
  spend: { tokens: number; usd: number | null; runs: number };
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Deriving a pilot result from a batch. Like every other metric in this
// harness, this is a pass over stored files: `pilotFromBatch` on an old batch
// directory reproduces its verdict without re-running anything.
// ---------------------------------------------------------------------------

export function pilotFromBatch(batchDir: string): PilotResult {
  const m = computeBatchMetrics(batchDir);
  const baseline = m.conditions.baseline;
  const withTool = m.conditions.with_tool;

  const warnings = [...m.warnings];
  if (withTool.runsAttempted > 0) {
    warnings.push(
      `This batch contains ${withTool.runsAttempted} with-tool run(s). A pilot is ` +
        "supposed to be baseline-only; the verdict below uses the baseline arm and " +
        "ignores the rest."
    );
  }
  if (m.toolRelevant === false) {
    warnings.push(
      "Scenario is marked toolRelevant: false. Over-use probes are exempt from the " +
        "pilot gate — a ceiling pass rate is expected and fine for them."
    );
  }

  const spend = batchSpend(m);

  return {
    schemaVersion: 1,
    scenarioId: m.scenarioId,
    toolRelevant: m.toolRelevant,
    model: m.model,
    n: m.n,
    batchId: m.batchId,
    batchDir,
    runsAttempted: baseline.runsAttempted,
    usableRuns: baseline.usable,
    excluded: baseline.excluded,
    indeterminateChecks: baseline.efficacy.indeterminate,
    passRate: baseline.efficacy.passRate,
    assessment: assessPilot(baseline.efficacy.passRate),
    baselineInvocations: baseline.adoption.k,
    spend,
    warnings,
  };
}

export type RunPilotOptions = Omit<RunBatchOptions, "conditions">;

/** Runs the baseline arm N times and assesses it against the gate. */
export async function runPilot(
  scenario: ResolvedScenario,
  opts: RunPilotOptions
): Promise<PilotResult> {
  const { batchDir } = await runBatch(scenario, { ...opts, conditions: ["baseline"] });
  const result = pilotFromBatch(batchDir);
  fs.writeFileSync(
    path.join(batchDir, "pilot.json"),
    JSON.stringify(result, null, 2) + "\n"
  );
  return result;
}
