/**
 * CLI. Node's own util.parseArgs — the surface is four subcommands, which does
 * not justify a dependency.
 */

import { parseArgs } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultCredentialsPath, inspectCredentials, stripInheritedAgentEnv } from "./isolation";
import { computeBatchMetrics } from "./metrics";
import { renderReport } from "./report";
import { buildAgentArgv, DudGuardError, HARNESS_VERSION, runBatch, runOrder } from "./runner";
import { loadScenario, ScenarioValidationError } from "./scenario";

const USAGE = `wasitused ${HARNESS_VERSION} — measure whether a coding agent actually uses your tool.

Usage:
  wasitused run <scenario.json> [options]     run the scenario with and without the tool
  wasitused report <batch-dir> [options]      recompute metrics and write report.html
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

Options for "report":
  -o, --out <file>         output path (default <batch-dir>/report.html)

Every metric is recomputed from the stored transcripts, so "report" and "metrics"
never spend a run.`;

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
