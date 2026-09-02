/**
 * CLI. Node's own util.parseArgs — the surface does not justify a dependency.
 */

import { parseArgs } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultCredentialsPath, inspectCredentials, stripInheritedAgentEnv } from "./isolation";
import { formatRate, formatSummary, formatUsd, formatTokens } from "./format";
import { computeBatchMetrics } from "./metrics";
import { PILOT_EXIT, runPilot, type PilotResult } from "./pilot";
import { renderReport } from "./report";
import { buildAgentArgv, DudGuardError, HARNESS_VERSION, runBatch, runOrder } from "./runner";
import { loadScenario, ScenarioValidationError } from "./scenario";
import { renderSuiteReport } from "./suite-report";
import { collectScenarioPaths, computeSuiteSummary, runSuite, type Budget } from "./suite";

const USAGE = `wasitused ${HARNESS_VERSION} — measure whether a coding agent actually uses your tool.

Usage:
  wasitused run <scenario.json> [options]     run the scenario with and without the tool
  wasitused pilot <scenario.json> [options]   baseline only — is this scenario worth running?
  wasitused suite <targets...> [options]      run several scenarios under one shared budget
  wasitused report <batch-dir> [options]      recompute metrics and write report.html
  wasitused suite-report <suite-dir> [opts]   recompute a suite summary and write report.html
  wasitused metrics <batch-dir>               print metrics as JSON on stdout
  wasitused validate <scenario.json>          check a scenario config without running it

Options for "run":
  -n, --n <count>          runs per condition (default 5)
  -o, --out <dir>          where batches are written (default ./runs)
      --model <id>         override the scenario's pinned model
      --credentials <path> credential file to copy into each isolated config
                           (default ~/.claude/.credentials.json)
      --agent-command <c>  agent executable (default "claude")
      --keep-temp          keep the per-run temp dirs for debugging
      --dry-run            print the exact isolation + spawn plan, run nothing

Options for "pilot":
  Same as "run", plus:
      --json               print the pilot result as JSON on stdout
  Runs the BASELINE ONLY (default -n 10) and applies the gate from METHODOLOGY.md:
  a baseline pass rate under 20% is a floor, over 80% is a ceiling, in between is
  usable. Exit codes: 0 valid, 3 floor, 4 ceiling, 5 indeterminate.

Options for "suite":
  <targets...>             scenario files, a scenario directory, or a directory of
                           scenario directories
  -n, --n <count>          runs per condition per scenario (default 5, or 10 with --pilot)
      --pilot              run every scenario as a baseline-only pilot
      --budget-usd <n>     cap total list-price-equivalent spend for the whole suite
      --budget-tokens <n>  cap total tokens for the whole suite
      --json               print the suite summary as JSON on stdout
  Plus -o/--out, --model, --credentials, --agent-command, --keep-temp.
  A scenario that cannot be afforded in full is skipped rather than truncated, and
  what ran vs. what was skipped is reported explicitly.

Options for "report" / "suite-report":
  -o, --out <file>         output path (default <dir>/report.html)

Every metric is recomputed from the stored transcripts, so "report", "suite-report"
and "metrics" never spend a run.`;

function fail(message: string): never {
  process.stderr.write(message.endsWith("\n") ? message : message + "\n");
  process.exit(1);
}

async function cmdRun(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      n: { type: "string", short: "n" },
      out: { type: "string", short: "o" },
      model: { type: "string" },
      credentials: { type: "string" },
      "agent-command": { type: "string" },
      "keep-temp": { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
  });
  const scenarioPath = positionals[0];
  if (!scenarioPath) fail("wasitused run: missing <scenario.json>\n\n" + USAGE);

  const scenario = loadScenario(scenarioPath);
  const n = values.n ? Number(values.n) : 5;
  if (!Number.isInteger(n) || n < 1) fail(`--n must be a positive integer, got "${values.n}"`);

  const outDir = path.resolve(values.out ?? "runs");
  const credentialsPath = path.resolve(values.credentials ?? defaultCredentialsPath());
  const model = values.model ?? scenario.agent.model;

  if (values["dry-run"]) {
    const { stripped } = stripInheritedAgentEnv();
    const credential = inspectCredentials(credentialsPath);
    const plan = {
      scenario: scenario.id,
      toolRelevant: scenario.toolRelevant,
      model,
      n,
      totalRuns: n * 2,
      order: runOrder(n).map((s) => `${s.condition}-${s.index}`),
      outDir,
      isolation: {
        configDir: "<temp>/config  (fresh CLAUDE_CONFIG_DIR per run, never ~/.claude)",
        workDir: "<temp>/work    (fresh copy of " + scenario.fixturePath + ")",
        strippedEnvVars: stripped,
        credential: {
          source: credential.source,
          remaining: credential.remainingHuman,
          expired: credential.expired,
          note: credential.note ?? null,
        },
      },
      argvWithTool: buildAgentArgv(
        scenario,
        model,
        true,
        scenario.tool.enable.mcpServers ? "<temp>/mcp.json" : null,
        values["agent-command"] ?? "claude"
      ),
      argvBaseline: buildAgentArgv(scenario, model, false, null, values["agent-command"] ?? "claude"),
      toolEnabledBy: scenario.tool.enable,
      invocationMatchers: scenario.tool.invocation,
      documentationMatchers: scenario.tool.documentation ?? null,
      check: scenario.check,
    };
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    return;
  }

  process.stderr.write(
    `wasitused: ${scenario.id} — ${n} runs per condition (${n * 2} total), model ${model}\n`
  );

  let batchDir: string;
  try {
    const result = await runBatch(scenario, {
      n,
      outDir,
      credentialsPath,
      model,
      ...(values["keep-temp"] ? { keepTemp: true } : {}),
      ...(values["agent-command"] ? { agentCommand: values["agent-command"] } : {}),
      log: (m) => process.stderr.write(`  ${m}\n`),
    });
    batchDir = result.batchDir;
  } catch (err) {
    if (err instanceof DudGuardError) {
      process.stderr.write(`\n!! DUD GUARD TRIPPED !!\n${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  const metrics = computeBatchMetrics(batchDir);
  fs.writeFileSync(
    path.join(batchDir, "metrics.json"),
    JSON.stringify(metrics, null, 2) + "\n"
  );
  const reportPath = path.join(batchDir, "report.html");
  fs.writeFileSync(reportPath, renderReport(metrics));

  process.stderr.write(`\nbatch:  ${batchDir}\nreport: ${reportPath}\n`);
  for (const warning of metrics.warnings) process.stderr.write(`warning: ${warning}\n`);
}

function printPilot(result: PilotResult): void {
  const a = result.assessment;
  const lines = [
    "",
    `pilot: ${result.scenarioId}  (baseline only, model ${result.model})`,
    `  baseline pass rate : ${formatRate(result.passRate)}`,
    `  usable runs        : ${result.usableRuns} of ${result.runsAttempted}`,
    `  verdict            : ${a.verdict.toUpperCase()}`,
    `  ${a.reason}`,
    `  ${a.recommendation}`,
    `  spend              : ${formatUsd(result.spend.usd)} / ${formatTokens(
      result.spend.tokens
    )} tokens over ${result.spend.runs} runs`,
    `  batch              : ${result.batchDir}`,
    "",
  ];
  process.stderr.write(lines.join("\n"));
  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
}

async function cmdPilot(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      n: { type: "string", short: "n" },
      out: { type: "string", short: "o" },
      model: { type: "string" },
      credentials: { type: "string" },
      "agent-command": { type: "string" },
      "keep-temp": { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  const scenarioPath = positionals[0];
  if (!scenarioPath) fail("wasitused pilot: missing <scenario.json>\n\n" + USAGE);

  const scenario = loadScenario(scenarioPath);
  // Default 10: the gate needs enough runs to distinguish a floor from bad luck.
  const n = values.n ? Number(values.n) : 10;
  if (!Number.isInteger(n) || n < 1) fail(`--n must be a positive integer, got "${values.n}"`);

  if (scenario.toolRelevant === false) {
    process.stderr.write(
      `note: ${scenario.id} is marked toolRelevant: false. Over-use probes are exempt ` +
        "from the pilot gate — a ceiling here is expected, not a problem.\n"
    );
  }

  process.stderr.write(
    `wasitused: piloting ${scenario.id} — ${n} baseline runs, model ${
      values.model ?? scenario.agent.model
    }\n`
  );

  let result: PilotResult;
  try {
    result = await runPilot(scenario, {
      n,
      outDir: path.resolve(values.out ?? "runs"),
      credentialsPath: path.resolve(values.credentials ?? defaultCredentialsPath()),
      ...(values.model ? { model: values.model } : {}),
      ...(values["keep-temp"] ? { keepTemp: true } : {}),
      ...(values["agent-command"] ? { agentCommand: values["agent-command"] } : {}),
      log: (m) => process.stderr.write(`  ${m}\n`),
    });
  } catch (err) {
    if (err instanceof DudGuardError) {
      process.stderr.write(`\n!! DUD GUARD TRIPPED !!\n${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  if (values.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  printPilot(result);
  process.exit(PILOT_EXIT[result.assessment.verdict]);
}

async function cmdSuite(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      n: { type: "string", short: "n" },
      out: { type: "string", short: "o" },
      model: { type: "string" },
      credentials: { type: "string" },
      "agent-command": { type: "string" },
      "keep-temp": { type: "boolean" },
      pilot: { type: "boolean" },
      "budget-usd": { type: "string" },
      "budget-tokens": { type: "string" },
      json: { type: "boolean" },
    },
  });
  if (positionals.length === 0) fail("wasitused suite: missing <targets...>\n\n" + USAGE);

  const mode = values.pilot ? "pilot" : "full";
  const n = values.n ? Number(values.n) : mode === "pilot" ? 10 : 5;
  if (!Number.isInteger(n) || n < 1) fail(`--n must be a positive integer, got "${values.n}"`);

  const numeric = (raw: string | undefined, flag: string): number | null => {
    if (raw === undefined) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      fail(`${flag} must be a positive number, got "${raw}"`);
    }
    return value;
  };
  const budget: Budget = {
    maxUsd: numeric(values["budget-usd"], "--budget-usd"),
    maxTokens: numeric(values["budget-tokens"], "--budget-tokens"),
  };

  const targets = collectScenarioPaths(positionals);
  process.stderr.write(
    `wasitused: suite (${mode}) — ${targets.length} scenario(s), N=${n}` +
      (budget.maxUsd !== null ? `, budget ${formatUsd(budget.maxUsd)}` : "") +
      (budget.maxTokens !== null ? `, budget ${formatTokens(budget.maxTokens)} tokens` : "") +
      "\n"
  );
  if (budget.maxUsd === null && budget.maxTokens === null) {
    process.stderr.write(
      "warning: no budget set. A full battery is hundreds of runs — pass --budget-usd " +
        "or --budget-tokens unless you mean it.\n"
    );
  }

  const { suiteDir } = await runSuite(positionals, {
    mode,
    budget,
    n,
    outDir: path.resolve(values.out ?? "runs"),
    credentialsPath: path.resolve(values.credentials ?? defaultCredentialsPath()),
    ...(values.model ? { model: values.model } : {}),
    ...(values["keep-temp"] ? { keepTemp: true } : {}),
    ...(values["agent-command"] ? { agentCommand: values["agent-command"] } : {}),
    log: (m) => process.stderr.write(`  ${m}\n`),
  });

  const summary = computeSuiteSummary(suiteDir);
  fs.writeFileSync(
    path.join(suiteDir, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n"
  );
  const reportPath = path.join(suiteDir, "report.html");
  fs.writeFileSync(reportPath, renderSuiteReport(summary));

  if (values.json) process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  printSuite(summary, suiteDir, reportPath);

  // Non-zero when the suite did not cover what it was asked to cover.
  const shortfall =
    summary.counts.skippedBudget +
    summary.counts.budgetStopped +
    summary.counts.failed +
    summary.counts.abortedDuds;
  if (shortfall > 0) process.exit(6);
}

function printSuite(
  summary: ReturnType<typeof computeSuiteSummary>,
  suiteDir: string,
  reportPath: string
): void {
  const out: string[] = ["", `suite:  ${suiteDir}`, `report: ${reportPath}`, ""];
  for (const sc of summary.scenarios) {
    const verdict = sc.verdict ? ` ${sc.verdict.toUpperCase().padEnd(13)}` : " ";
    out.push(
      `  ${sc.scenarioId.padEnd(24)}${sc.status.padEnd(16)}${verdict}` +
        `baseline ${sc.baselinePassRate ? formatRate(sc.baselinePassRate) : "n/a"}`
    );
    if (sc.reason) out.push(`      ${sc.reason}`);
    if (sc.usableRuns > 1) {
      out.push(`      tokens/run ${formatSummary(sc.tokensPerRun, 0)}`);
    }
  }
  out.push("");
  out.push(
    `  spend: ${formatUsd(summary.spend.usd)} / ${formatTokens(
      summary.spend.tokens
    )} tokens over ${summary.spend.runs} runs`
  );
  if (summary.mode === "pilot") {
    out.push(
      `  gate:  ${summary.counts.valid} valid, ${summary.counts.floor} floor, ` +
        `${summary.counts.ceiling} ceiling, ${summary.counts.indeterminate} indeterminate`
    );
  }
  out.push("");
  process.stderr.write(out.join("\n"));
  for (const warning of summary.warnings) process.stderr.write(`warning: ${warning}\n`);
}

function cmdSuiteReport(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: "string", short: "o" }, json: { type: "boolean" } },
  });
  const suiteDir = positionals[0];
  if (!suiteDir) fail("wasitused suite-report: missing <suite-dir>\n\n" + USAGE);

  const resolved = path.resolve(suiteDir);
  const summary = computeSuiteSummary(resolved);
  fs.writeFileSync(
    path.join(resolved, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n"
  );
  const out = path.resolve(values.out ?? path.join(resolved, "report.html"));
  fs.writeFileSync(out, renderSuiteReport(summary));
  if (values.json) process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  else process.stdout.write(out + "\n");
  for (const warning of summary.warnings) process.stderr.write(`warning: ${warning}\n`);
}

function cmdReport(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: "string", short: "o" } },
  });
  const batchDir = positionals[0];
  if (!batchDir) fail("wasitused report: missing <batch-dir>\n\n" + USAGE);

  const resolved = path.resolve(batchDir);
  const metrics = computeBatchMetrics(resolved);
  fs.writeFileSync(
    path.join(resolved, "metrics.json"),
    JSON.stringify(metrics, null, 2) + "\n"
  );
  const out = path.resolve(values.out ?? path.join(resolved, "report.html"));
  fs.writeFileSync(out, renderReport(metrics));
  process.stdout.write(out + "\n");
  for (const warning of metrics.warnings) process.stderr.write(`warning: ${warning}\n`);
}

function cmdMetrics(argv: string[]): void {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
  const batchDir = positionals[0];
  if (!batchDir) fail("wasitused metrics: missing <batch-dir>\n\n" + USAGE);
  process.stdout.write(
    JSON.stringify(computeBatchMetrics(path.resolve(batchDir)), null, 2) + "\n"
  );
}

function cmdValidate(argv: string[]): void {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
  const scenarioPath = positionals[0];
  if (!scenarioPath) fail("wasitused validate: missing <scenario.json>\n\n" + USAGE);
  const scenario = loadScenario(scenarioPath);
  process.stdout.write(
    `ok: ${scenario.id} (toolRelevant=${scenario.toolRelevant}, model=${scenario.agent.model})\n` +
      `  fixture: ${scenario.fixturePath}\n` +
      `  check:   ${scenario.check.command}\n` +
      `  tool:    ${scenario.tool.name}\n`
  );
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "run":
        await cmdRun(rest);
        return;
      case "pilot":
        await cmdPilot(rest);
        return;
      case "suite":
        await cmdSuite(rest);
        return;
      case "suite-report":
        cmdSuiteReport(rest);
        return;
      case "report":
        cmdReport(rest);
        return;
      case "metrics":
        cmdMetrics(rest);
        return;
      case "validate":
        cmdValidate(rest);
        return;
      case "--version":
      case "-v":
        process.stdout.write(HARNESS_VERSION + "\n");
        return;
      case undefined:
      case "--help":
      case "-h":
      case "help":
        process.stdout.write(USAGE + "\n");
        return;
      default:
        fail(`wasitused: unknown command "${command}"\n\n${USAGE}`);
    }
  } catch (err) {
    if (err instanceof ScenarioValidationError) fail(err.message);
    throw err;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(String((err && err.stack) || err) + "\n");
    process.exit(1);
  });
}
