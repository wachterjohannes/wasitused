/**
 * Metrics: a pure second pass over what a batch stored on disk.
 *
 * Nothing in here talks to an agent. Given a batch directory, every number in
 * the report is recomputed from `batch.json`, the per-run `run.json`,
 * `check.json` and `transcript.jsonl`. That is deliberate — a metric you can
 * only obtain by re-running the batch is a metric you cannot audit.
 *
 * Three rules are enforced rather than left to the reader:
 *   - `solved` stays null when it could not be determined.
 *   - Runs that measured nothing (zero-cost duds, unparseable transcripts) are
 *     excluded and counted out loud, never silently folded into "failed".
 *   - Every effect is reported next to the invocation counts it depends on,
 *     and separately for the subset of runs that actually invoked the tool.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  bestEffortUsd,
  COST_CAVEAT,
  emptyTotals,
  type TokenTotals,
  type UsdSource,
} from "./pricing";
import {
  meanDelta,
  rate,
  rateDelta,
  summarize,
  type Rate,
  type Summary,
} from "./stats";
import { analyzeTranscriptFile } from "./transcript";
import type { BatchRecord, CheckRecord, Condition, RunRecord } from "./types";
import { CONDITIONS } from "./types";

export type Exclusion = "dud-zero-cost" | "unparseable-transcript" | "missing-run-record";

export interface RunMetrics {
  runId: string;
  condition: Condition;
  index: number;
  model: string;
  usable: boolean;
  exclusion: Exclusion | null;
  exclusionReason: string | null;
  invoked: boolean;
  invocationCount: number;
  /** Invocations that came back an error. Still counted as adoption. */
  invocationFailures: number;
  /** Invocations whose outcome was unknowable (no result, or shell-masked). */
  invocationStatusUnknown: number;
  /** Invocations with a knowable outcome — the failure-rate denominator. */
  invocationDeterminate: number;
  documentationCount: number;
  /** Read the tool's docs but never called it — the distinction adoption depends on. */
  documentationOnly: boolean;
  solved: boolean | null;
  solvedReason: string;
  turns: number;
  tokens: TokenTotals;
  /** "result-line" (authoritative) or "deduped-messages" (output is a lower bound). */
  tokensSource: string;
  wallClockMs: number;
  usdListEquivalent: number | null;
  /**
   * "agent-reported" uses the run's own list-price figure, which covers every
   * model it touched; "price-table" applies this harness's per-model list
   * prices to the token counts. Neither is a billed amount.
   */
  usdSource: UsdSource;
  transcriptComplete: boolean;
  transcriptMalformedLines: number;
  exitCode: number | null;
  timedOut: boolean;
  credentialRemainingHuman: string | null;
  credentialExpired: boolean;
}

export interface CostBlock {
  totalTokens: Summary;
  outputTokens: Summary;
  turns: Summary;
  wallClockMs: Summary;
  usdListEquivalent: Summary;
}

export interface ConditionMetrics {
  condition: Condition;
  runsAttempted: number;
  excluded: { dudZeroCost: number; unparseableTranscript: number; missingRunRecord: number };
  usable: number;
  adoption: Rate;
  /**
   * Call health. `failureRate` is over calls with a KNOWABLE outcome only —
   * a call whose exit status the shell masked cannot be scored either way, and
   * counting it as a success is how a 100%-broken tool once read as 27%.
   */
  invocationHealth: {
    calls: number;
    failed: number;
    statusUnknown: number;
    determinate: number;
    failureRate: Rate;
  };
  documentationOnly: Rate;
  efficacy: {
    solved: number;
    notSolved: number;
    indeterminate: number;
    passRate: Rate;
  };
  cost: CostBlock;
}

export interface InvocationCounts {
  withToolInvoked: number;
  withToolUsable: number;
  baselineInvoked: number;
  baselineUsable: number;
}

export interface EfficacyComparison {
  baseline: Rate;
  withToolAll: Rate;
  withToolInvoked: Rate;
  withToolNotInvoked: Rate;
  deltaAllRuns: number | null;
  deltaInvokedOnly: number | null;
  invocationCounts: InvocationCounts;
  note: string;
}

export interface CostComparison {
  metric: string;
  baseline: Summary;
  withToolAll: Summary;
  withToolInvoked: Summary;
  deltaAllRuns: number | null;
  deltaInvokedOnly: number | null;
  invocationCounts: InvocationCounts;
}

export interface OverUse {
  applicable: boolean;
  rate: Rate | null;
  note: string;
}

export interface BatchMetrics {
  schemaVersion: 1;
  batchId: string;
  /** Conditions this batch actually ran. A pilot runs baseline only. */
  conditionsRun: Condition[];
  /** True when only one condition ran, so no with/without comparison exists. */
  singleCondition: boolean;
  scenarioId: string;
  toolName: string;
  toolRelevant: boolean;
  model: string;
  n: number;
  aborted: boolean;
  abortReason: string | null;
  generatedAt: string;
  costCaveat: string;
  runs: RunMetrics[];
  conditions: Record<Condition, ConditionMetrics>;
  efficacy: EfficacyComparison;
  cost: CostComparison[];
  overUse: OverUse;
  warnings: string[];
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function emptyCost(): CostBlock {
  const none = summarize([]);
  return {
    totalTokens: none,
    outputTokens: none,
    turns: none,
    wallClockMs: none,
    usdListEquivalent: none,
  };
}

function costOf(runs: RunMetrics[]): CostBlock {
  return {
    totalTokens: summarize(runs.map((r) => r.tokens.total)),
    outputTokens: summarize(runs.map((r) => r.tokens.output)),
    turns: summarize(runs.map((r) => r.turns)),
    wallClockMs: summarize(runs.map((r) => r.wallClockMs)),
    usdListEquivalent: summarize(
      runs
        .map((r) => r.usdListEquivalent)
        .filter((v): v is number => v !== null)
    ),
  };
}

function passRateOf(runs: RunMetrics[]): Rate {
  const solved = runs.filter((r) => r.solved === true).length;
  const notSolved = runs.filter((r) => r.solved === false).length;
  return rate(solved, solved + notSolved);
}

/** Reads one run directory back into a metrics row. */
export function metricsForRun(
  batchDir: string,
  runDir: string,
  batch: BatchRecord
): RunMetrics {
  const absRunDir = path.resolve(batchDir, runDir);
  const record = readJson<RunRecord>(path.join(absRunDir, "run.json"));
  if (!record) {
    const runId = path.basename(absRunDir);
    return {
      runId,
      condition: runId.startsWith("baseline") ? "baseline" : "with_tool",
      index: 0,
      model: batch.model,
      usable: false,
      exclusion: "missing-run-record",
      exclusionReason: `no readable run.json in ${runDir}`,
      invoked: false,
      invocationCount: 0,
      invocationFailures: 0,
      invocationStatusUnknown: 0,
      invocationDeterminate: 0,
      documentationCount: 0,
      documentationOnly: false,
      solved: null,
      solvedReason: "run record missing",
      turns: 0,
      tokens: emptyTotals(),
      tokensSource: "deduped-messages",
      wallClockMs: 0,
      usdListEquivalent: null,
      usdSource: "unavailable",
      transcriptComplete: false,
      transcriptMalformedLines: 0,
      exitCode: null,
      timedOut: false,
      credentialRemainingHuman: null,
      credentialExpired: false,
    };
  }

  const analysis = analyzeTranscriptFile(
    path.resolve(batchDir, record.transcriptFile),
    batch.scenarioSnapshot.tool
  );
  const check = readJson<CheckRecord>(path.resolve(batchDir, record.checkFile));
  const usd = bestEffortUsd(record.model, analysis.totals, analysis.reportedCostUsd);

  let exclusion: Exclusion | null = null;
  let exclusionReason: string | null = null;
  if (!analysis.parseable) {
    exclusion = "unparseable-transcript";
    exclusionReason = analysis.exists
      ? `transcript has ${analysis.malformedLines} malformed line(s) of ${analysis.totalLines}` +
        (analysis.parseErrors[0] ? ` (${analysis.parseErrors[0]})` : "")
      : "transcript file is missing or unreadable";
  } else if (analysis.totals.total === 0) {
    exclusion = "dud-zero-cost";
    exclusionReason =
      "the agent produced no billable tokens — nothing was measured in this run";
  }

  // An unreadable transcript means invocation cannot be established, so the
  // outcome cannot be attributed either: solved is reported as null.
  const solved =
    exclusion === "unparseable-transcript" ? null : check?.solved ?? null;
  const solvedReason =
    exclusion === "unparseable-transcript"
      ? "transcript unparseable — outcome cannot be attributed to a condition"
      : check?.reason ?? "no check record found";

  return {
    runId: record.runId,
    condition: record.condition,
    index: record.index,
    model: record.model,
    usable: exclusion === null,
    exclusion,
    exclusionReason,
    invoked: analysis.invoked,
    invocationCount: analysis.invocationCount,
    invocationFailures: analysis.invocationFailures,
    invocationStatusUnknown: analysis.invocationStatusUnknown,
    invocationDeterminate: analysis.invocationDeterminate,
    documentationCount: analysis.documentationCount,
    documentationOnly: analysis.readDocs && !analysis.invoked,
    solved,
    solvedReason,
    turns: analysis.turns,
    tokens: analysis.totals,
    tokensSource: analysis.totalsSource,
    wallClockMs: record.wallClockMs,
    usdListEquivalent: usd.usd,
    usdSource: usd.source,
    transcriptComplete: analysis.complete,
    transcriptMalformedLines: analysis.malformedLines,
    exitCode: record.exitCode,
    timedOut: record.timedOut,
    credentialRemainingHuman: record.credential.remainingHuman,
    credentialExpired: record.credential.expired,
  };
}

function conditionMetrics(
  condition: Condition,
  all: RunMetrics[]
): ConditionMetrics {
  const attempted = all.filter((r) => r.condition === condition);
  const usable = attempted.filter((r) => r.usable);
  const solved = usable.filter((r) => r.solved === true).length;
  const notSolved = usable.filter((r) => r.solved === false).length;
  const indeterminate = usable.filter((r) => r.solved === null).length;

  return {
    condition,
    runsAttempted: attempted.length,
    excluded: {
      dudZeroCost: attempted.filter((r) => r.exclusion === "dud-zero-cost").length,
      unparseableTranscript: attempted.filter(
        (r) => r.exclusion === "unparseable-transcript"
      ).length,
      missingRunRecord: attempted.filter((r) => r.exclusion === "missing-run-record")
        .length,
    },
    usable: usable.length,
    adoption: rate(usable.filter((r) => r.invoked).length, usable.length),
    invocationHealth: (() => {
      const calls = usable.reduce((a, r) => a + r.invocationCount, 0);
      const failed = usable.reduce((a, r) => a + r.invocationFailures, 0);
      const statusUnknown = usable.reduce((a, r) => a + r.invocationStatusUnknown, 0);
      const determinate = calls - statusUnknown;
      return { calls, failed, statusUnknown, determinate, failureRate: rate(failed, determinate) };
    })(),
    documentationOnly: rate(
      usable.filter((r) => r.documentationOnly).length,
      usable.length
    ),
    efficacy: { solved, notSolved, indeterminate, passRate: passRateOf(usable) },
    cost: usable.length > 0 ? costOf(usable) : emptyCost(),
  };
}

function costComparison(
  metric: string,
  pick: (block: CostBlock) => Summary,
  baseline: RunMetrics[],
  withAll: RunMetrics[],
  withInvoked: RunMetrics[],
  counts: InvocationCounts
): CostComparison {
  const b = baseline.length ? pick(costOf(baseline)) : summarize([]);
  const wa = withAll.length ? pick(costOf(withAll)) : summarize([]);
  const wi = withInvoked.length ? pick(costOf(withInvoked)) : summarize([]);
  return {
    metric,
    baseline: b,
    withToolAll: wa,
    withToolInvoked: wi,
    deltaAllRuns: meanDelta(wa, b),
    deltaInvokedOnly: meanDelta(wi, b),
    invocationCounts: counts,
  };
}

export function computeBatchMetrics(batchDir: string): BatchMetrics {
  const batch = readJson<BatchRecord>(path.join(batchDir, "batch.json"));
  if (!batch) {
    throw new Error(
      `No readable batch.json in ${batchDir} — not a wasitused batch directory.`
    );
  }

  const runDirs =
    batch.runDirs.length > 0
      ? batch.runDirs
      : fs.existsSync(path.join(batchDir, "runs"))
        ? fs
            .readdirSync(path.join(batchDir, "runs"))
            .sort()
            .map((d) => path.join("runs", d))
        : [];

  const runs = runDirs.map((dir) => metricsForRun(batchDir, dir, batch));

  const conditions = {
    with_tool: conditionMetrics("with_tool", runs),
    baseline: conditionMetrics("baseline", runs),
  } as Record<Condition, ConditionMetrics>;

  const usableWith = runs.filter((r) => r.condition === "with_tool" && r.usable);
  const usableBaseline = runs.filter((r) => r.condition === "baseline" && r.usable);
  const withInvoked = usableWith.filter((r) => r.invoked);
  const withNotInvoked = usableWith.filter((r) => !r.invoked);

  const counts: InvocationCounts = {
    withToolInvoked: withInvoked.length,
    withToolUsable: usableWith.length,
    baselineInvoked: usableBaseline.filter((r) => r.invoked).length,
    baselineUsable: usableBaseline.length,
  };

  const baselinePass = passRateOf(usableBaseline);
  const withAllPass = passRateOf(usableWith);
  const withInvokedPass = passRateOf(withInvoked);
  const withNotInvokedPass = passRateOf(withNotInvoked);

  const efficacy: EfficacyComparison = {
    baseline: baselinePass,
    withToolAll: withAllPass,
    withToolInvoked: withInvokedPass,
    withToolNotInvoked: withNotInvokedPass,
    deltaAllRuns: rateDelta(withAllPass, baselinePass),
    deltaInvokedOnly: rateDelta(withInvokedPass, baselinePass),
    invocationCounts: counts,
    note:
      counts.withToolInvoked === 0
        ? `The tool was invoked in 0 of ${counts.withToolUsable} usable with_tool runs. ` +
          "Any difference against baseline is NOT an effect of the tool — the tool never ran."
        : `The tool was invoked in ${counts.withToolInvoked} of ${counts.withToolUsable} ` +
          "usable with_tool runs. Only the invoked-only delta is attributable to the tool.",
  };

  const cost: CostComparison[] = [
    costComparison("total tokens", (c) => c.totalTokens, usableBaseline, usableWith, withInvoked, counts),
    costComparison("output tokens", (c) => c.outputTokens, usableBaseline, usableWith, withInvoked, counts),
    costComparison("turns", (c) => c.turns, usableBaseline, usableWith, withInvoked, counts),
    costComparison("wall clock (ms)", (c) => c.wallClockMs, usableBaseline, usableWith, withInvoked, counts),
    costComparison("USD (list-price equivalent)", (c) => c.usdListEquivalent, usableBaseline, usableWith, withInvoked, counts),
  ];

  const overUse: OverUse = batch.scenarioSnapshot.toolRelevant
    ? {
        applicable: false,
        rate: null,
        note:
          "Scenario is marked toolRelevant: true. Over-use is only meaningful in " +
          "scenarios where the tool cannot help; add at least one toolRelevant: false " +
          "scenario to measure it.",
      }
    : {
        applicable: true,
        rate: conditions.with_tool.adoption,
        note:
          "Scenario is marked toolRelevant: false. Every invocation here is context " +
          "spent for no possible gain — this rate IS the over-use rate.",
      };

  const warnings: string[] = [];
  if (batch.aborted) {
    warnings.push(`Batch was ABORTED: ${batch.abortReason ?? "no reason recorded"}`);
  }
  const totalExcluded = runs.filter((r) => !r.usable).length;
  if (totalExcluded > 0) {
    warnings.push(
      `${totalExcluded} of ${runs.length} runs were excluded as unusable ` +
        `(${runs.filter((r) => r.exclusion === "dud-zero-cost").length} zero-cost duds, ` +
        `${runs.filter((r) => r.exclusion === "unparseable-transcript").length} unparseable transcripts, ` +
        `${runs.filter((r) => r.exclusion === "missing-run-record").length} missing run records). ` +
        "They are excluded from every rate below and are NOT counted as failures."
    );
  }
  for (const c of CONDITIONS) {
    const health = conditions[c].invocationHealth;
    if (health.statusUnknown > 0) {
      warnings.push(
        `${c}: ${health.statusUnknown} of ${health.calls} tool call(s) have an unknowable ` +
          "outcome — the shell masked the exit status (a pipeline or command separator), " +
          "or no result was recorded. They are excluded from the failure rate rather than " +
          "counted as successes."
      );
    }
    if (health.failed > 0) {
      warnings.push(
        `${c}: ${health.failed} of ${health.determinate} determinate tool call(s) returned an error. ` +
          "Those still count as adoption — the agent did call the tool — but a cost or " +
          "efficacy difference in those runs reflects a broken tool, not a used one."
      );
    }
  }
  if (counts.baselineInvoked > 0) {
    warnings.push(
      `ISOLATION LEAK: the tool was invoked in ${counts.baselineInvoked} baseline run(s). ` +
        "The baseline is supposed to have no access to it — treat this batch as invalid " +
        "until the scenario's `tool.enable` and the invocation matchers are checked."
    );
  }
  for (const c of CONDITIONS) {
    const m = conditions[c];
    if (m.usable > 0 && m.efficacy.indeterminate > 0) {
      warnings.push(
        `${c}: ${m.efficacy.indeterminate} of ${m.usable} usable runs have solved=null ` +
          "(the success check could not determine an answer). They are excluded from the " +
          "pass rate rather than counted as failures."
      );
    }
  }
  if (counts.withToolUsable > 0 && counts.withToolInvoked === 0) {
    warnings.push(efficacy.note);
  }
  if (runs.length > 0 && CONDITIONS.filter((c) => conditions[c].runsAttempted > 0).length < 2) {
    warnings.push(
      "This batch ran only one condition, so no with-tool/baseline comparison exists. " +
        "Every delta below is null by construction — this is a pilot, not a result."
    );
  }
  const lowerBound = runs.filter(
    (r) => r.usable && r.tokensSource === "deduped-messages"
  );
  if (lowerBound.length > 0) {
    warnings.push(
      `${lowerBound.length} usable run(s) never reached a terminal usage report ` +
        "(killed, timed out, or truncated). Their token and cost figures are derived " +
        "from mid-stream per-message snapshots, which under-report output tokens — " +
        "treat those runs' cost as a lower bound, not a measurement."
    );
  }
  const expired = runs.filter((r) => r.credentialExpired);
  if (expired.length > 0) {
    warnings.push(
      `${expired.length} run(s) started with an already-expired credential. ` +
        "Those runs measured nothing regardless of what they appear to show."
    );
  }
  if (batch.n < 20) {
    warnings.push(
      `N=${batch.n} per condition. This is pilot scale: enough to prove the loop and ` +
        "to gate a scenario, not enough to publish. Citable numbers need N=20-30 per condition."
    );
  }

  const conditionsRun = CONDITIONS.filter(
    (c) => conditions[c].runsAttempted > 0
  );

  return {
    schemaVersion: 1,
    batchId: batch.batchId,
    conditionsRun,
    singleCondition: conditionsRun.length < 2,
    scenarioId: batch.scenarioId,
    toolName: batch.scenarioSnapshot.tool.name,
    toolRelevant: batch.scenarioSnapshot.toolRelevant,
    model: batch.model,
    n: batch.n,
    aborted: batch.aborted,
    abortReason: batch.abortReason,
    generatedAt: new Date().toISOString(),
    costCaveat: COST_CAVEAT,
    runs,
    conditions,
    efficacy,
    cost,
    overUse,
    warnings,
  };
}

/**
 * What a batch actually spent, including runs that turned out to be unusable.
 * Excluding duds from *metrics* is correct; excluding them from *spend* would
 * be lying about the bill. Duds cost nothing by definition, but an unparseable
 * run cost whatever it burned before the transcript broke.
 */
export function batchSpend(m: BatchMetrics): {
  tokens: number;
  usd: number | null;
  runs: number;
} {
  let tokens = 0;
  let usd: number | null = null;
  for (const run of m.runs) {
    tokens += run.tokens.total;
    if (run.usdListEquivalent !== null) usd = (usd ?? 0) + run.usdListEquivalent;
  }
  return { tokens, usd, runs: m.runs.length };
}
