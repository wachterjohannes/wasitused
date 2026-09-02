/**
 * The run loop: for one scenario, run the agent N times with the tool available
 * and N times without, storing every transcript on disk.
 *
 * Nothing here computes a metric. Metrics are a separate pass over the stored
 * files (see metrics.ts) so that every number in a report can be recomputed
 * from the artifacts without spending another run.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { prepareIsolatedRun, inspectCredentials, stripInheritedAgentEnv } from "./isolation";
import { bestEffortUsd } from "./pricing";
import { analyzeTranscriptFile } from "./transcript";
import type {
  BatchRecord,
  CheckRecord,
  Condition,
  ResolvedScenario,
  RunRecord,
} from "./types";
import { CONDITIONS } from "./types";

export const HARNESS_VERSION = "0.2.0";

/** Consecutive zero-cost runs that abort a batch. */
export const DUD_GUARD_THRESHOLD = 3;

export class DudGuardError extends Error {
  constructor(
    message: string,
    public readonly consecutiveDuds: number,
    public readonly runIds: string[]
  ) {
    super(message);
    this.name = "DudGuardError";
  }
}

export interface SpawnAgentRequest {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  transcriptFile: string;
  stderrFile: string;
  timeoutMs: number;
}

export interface SpawnAgentResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

/** Injectable so the failure-mode tests can drive the loop without spending money. */
export type SpawnAgentFn = (req: SpawnAgentRequest) => Promise<SpawnAgentResult>;

export const spawnClaudeAgent: SpawnAgentFn = (req) =>
  new Promise<SpawnAgentResult>((resolve, reject) => {
    const transcript = fs.createWriteStream(req.transcriptFile);
    const stderr = fs.createWriteStream(req.stderrFile);
    const [command, ...args] = req.argv;
    const child = spawn(command as string, args, {
      cwd: req.cwd,
      env: req.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, req.timeoutMs);

    child.stdout.pipe(transcript);
    child.stderr.pipe(stderr);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // Let the streams flush before the caller reads the transcript back.
      let pending = 2;
      const done = () => {
        if (--pending === 0) resolve({ exitCode: code, signal, timedOut });
      };
      transcript.end(done);
      stderr.end(done);
    });
  });

/** What one finished run cost, handed to the budget hook. */
export interface RunProgress {
  runId: string;
  condition: Condition;
  index: number;
  tokens: number;
  usd: number | null;
  invoked: boolean;
  solved: boolean | null;
  wallClockMs: number;
  /** Duds are reported too — they cost nothing, but the caller may want to know. */
  zeroCost: boolean;
}

export interface RunBatchOptions {
  n: number;
  outDir: string;
  credentialsPath: string;
  model?: string;
  /**
   * Which conditions to run, in the order they are interleaved.
   * Defaults to both. `pilot` passes ["baseline"] only.
   */
  conditions?: Condition[];
  /**
   * Called after every completed run. Returning a stop reason ends the batch
   * cleanly (recorded as stoppedEarly, not as an abort) — this is how the suite
   * enforces a shared budget at run granularity rather than only between
   * scenarios.
   */
  onRunComplete?: (progress: RunProgress) => string | null;
  keepTemp?: boolean;
  spawnAgent?: SpawnAgentFn;
  agentCommand?: string;
  now?: () => Date;
  log?: (message: string) => void;
  /** Overrides the temp root used for isolated runs (tests only). */
  tmpRoot?: string;
}

export function buildAgentArgv(
  scenario: ResolvedScenario,
  model: string,
  toolEnabled: boolean,
  mcpConfigPath: string | null,
  agentCommand = "claude"
): string[] {
  const argv = [
    agentCommand,
    "-p",
    scenario.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
    "--max-turns",
    String(scenario.agent.maxTurns),
    "--permission-mode",
    "bypassPermissions",
  ];
  if (toolEnabled && mcpConfigPath) {
    argv.push("--mcp-config", mcpConfigPath, "--strict-mcp-config");
  }
  const append = scenario.tool.enable.appendSystemPrompt;
  if (toolEnabled && append) {
    argv.push("--append-system-prompt", append);
  }
  return argv;
}

/**
 * Runs the scenario's success check against the agent's own artifact.
 *
 * Contract: exit 0 = solved, exit 1 = not solved, anything else (including a
 * crash or a timeout) = indeterminate. Indeterminate is recorded as
 * `solved: null` and never collapsed into false; a measurement that did not
 * happen is not a failure.
 */
export function runCheck(
  scenario: ResolvedScenario,
  workDir: string
): Promise<CheckRecord> {
  return new Promise<CheckRecord>((resolve) => {
    const started = Date.now();
    const child = spawn(scenario.check.command, {
      cwd: workDir,
      shell: true,
      env: {
        ...process.env,
        WASITUSED_WORK_DIR: workDir,
        // The check lives outside the fixture on purpose: the agent must not be
        // able to read the expected answer or edit the thing that grades it.
        WASITUSED_SCENARIO_DIR: scenario.dir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, scenario.check.timeoutMs);

    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));

    const finish = (
      solved: boolean | null,
      reason: string,
      exitCode: number | null
    ) => {
      clearTimeout(timer);
      resolve({
        solved,
        reason,
        command: scenario.check.command,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        stdout: stdout.slice(-8000),
        stderr: stderr.slice(-8000),
      });
    };

    child.on("error", (err) =>
      finish(null, `check could not be executed: ${err.message}`, null)
    );
    child.on("close", (code) => {
      if (timedOut) {
        finish(null, `check timed out after ${scenario.check.timeoutMs}ms`, code);
      } else if (code === 0) {
        finish(true, "check exited 0", code);
      } else if (code === 1) {
        finish(false, "check exited 1", code);
      } else {
        finish(
          null,
          `check exited ${code} — indeterminate, not counted as a failure`,
          code
        );
      }
    });
  });
}

function pad(n: number): string {
  return String(n).padStart(3, "0");
}

/** Runs one condition/index pair end to end and persists everything it produced. */
export async function runOnce(
  scenario: ResolvedScenario,
  condition: Condition,
  index: number,
  batchDir: string,
  opts: RunBatchOptions
): Promise<{ record: RunRecord; check: CheckRecord }> {
  const model = opts.model ?? scenario.agent.model;
  const toolEnabled = condition === "with_tool";
  const runId = `${condition}-${pad(index)}`;
  const runDir = path.join(batchDir, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });

  const isolated = prepareIsolatedRun({
    scenarioId: scenario.id,
    condition,
    index,
    fixturePath: scenario.fixturePath,
    scenarioDir: scenario.dir,
    toolEnabled,
    ...(scenario.tool.enable.skills ? { skills: scenario.tool.enable.skills } : {}),
    ...(scenario.tool.enable.fixtureFiles
      ? { fixtureFiles: scenario.tool.enable.fixtureFiles }
      : {}),
    ...(scenario.tool.enable.mcpServers
      ? { mcpServers: scenario.tool.enable.mcpServers }
      : {}),
    credentialsPath: opts.credentialsPath,
    ...(opts.tmpRoot ? { tmpRoot: opts.tmpRoot } : {}),
  });

  const credential = inspectCredentials(opts.credentialsPath);
  credential.copied = fs.existsSync(
    path.join(isolated.configDir, ".credentials.json")
  );

  const { env: baseEnv, stripped } = stripInheritedAgentEnv();
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    CLAUDE_CONFIG_DIR: isolated.configDir,
    ...(toolEnabled ? scenario.tool.enable.env ?? {} : {}),
  };

  const argv = buildAgentArgv(
    scenario,
    model,
    toolEnabled,
    isolated.mcpConfigPath,
    opts.agentCommand
  );

  const transcriptFile = path.join(runDir, "transcript.jsonl");
  const stderrFile = path.join(runDir, "agent.stderr.log");
  const checkFile = path.join(runDir, "check.json");
  const artifactDir = path.join(runDir, "artifact");

  const startedAt = (opts.now?.() ?? new Date()).toISOString();
  const startedMs = Date.now();
  const spawnAgent = opts.spawnAgent ?? spawnClaudeAgent;
  let spawnResult: SpawnAgentResult;
  try {
    spawnResult = await spawnAgent({
      argv,
      cwd: isolated.workDir,
      env,
      transcriptFile,
      stderrFile,
      timeoutMs: scenario.agent.timeoutMs,
    });
  } catch (err) {
    fs.appendFileSync(
      stderrFile,
      `\nwasitused: agent process could not be started: ${(err as Error).message}\n`
    );
    spawnResult = { exitCode: null, signal: null, timedOut: false };
  }
  const wallClockMs = Date.now() - startedMs;
  const endedAt = (opts.now?.() ?? new Date()).toISOString();

  const check = await runCheck(scenario, isolated.workDir);
  fs.writeFileSync(checkFile, JSON.stringify(check, null, 2) + "\n");

  // Keep the artifact: it is the ground truth the check ran against.
  fs.cpSync(isolated.workDir, artifactDir, { recursive: true });

  const record: RunRecord = {
    schemaVersion: 1,
    runId,
    scenarioId: scenario.id,
    condition,
    index,
    model,
    maxTurns: scenario.agent.maxTurns,
    toolEnabled,
    startedAt,
    endedAt,
    wallClockMs,
    exitCode: spawnResult.exitCode,
    signal: spawnResult.signal,
    timedOut: spawnResult.timedOut,
    credential,
    argv,
    envKeysStripped: stripped,
    transcriptFile: path.relative(batchDir, transcriptFile),
    stderrFile: path.relative(batchDir, stderrFile),
    checkFile: path.relative(batchDir, checkFile),
    artifactDir: path.relative(batchDir, artifactDir),
    tempDir: isolated.tempDir,
  };
  fs.writeFileSync(
    path.join(runDir, "run.json"),
    JSON.stringify(record, null, 2) + "\n"
  );

  if (!opts.keepTemp) isolated.cleanup();

  return { record, check };
}

/**
 * Interleaves the two conditions (with, without, with, without, ...) rather
 * than running all of one then all of the other, so that drift over the batch
 * — rate limits, model routing, a token nearing expiry — hits both conditions
 * evenly instead of loading onto whichever ran last.
 */
export function runOrder(
  n: number,
  conditions: Condition[] = CONDITIONS
): Array<{ condition: Condition; index: number }> {
  const order: Array<{ condition: Condition; index: number }> = [];
  for (let i = 1; i <= n; i++) {
    for (const condition of conditions) order.push({ condition, index: i });
  }
  return order;
}

export async function runBatch(
  scenario: ResolvedScenario,
  opts: RunBatchOptions
): Promise<{ batchDir: string; batch: BatchRecord }> {
  const log = opts.log ?? (() => {});
  const model = opts.model ?? scenario.agent.model;
  const now = opts.now ?? (() => new Date());
  const batchId = `${now().toISOString().replace(/[:.]/g, "-")}-${scenario.id}`;
  const batchDir = path.join(opts.outDir, batchId);
  fs.mkdirSync(path.join(batchDir, "runs"), { recursive: true });

  const conditions = opts.conditions ?? CONDITIONS;
  const credential = inspectCredentials(opts.credentialsPath);
  log(
    `credential: source=${credential.source} remaining=${
      credential.remainingHuman ?? "unknown"
    }${credential.expired ? " EXPIRED" : ""}`
  );
  if (credential.note) log(`credential note: ${credential.note}`);

  const batch: BatchRecord = {
    schemaVersion: 1,
    batchId,
    scenarioId: scenario.id,
    scenarioConfigPath: scenario.configPath,
    scenarioSnapshot: {
      id: scenario.id,
      ...(scenario.description !== undefined
        ? { description: scenario.description }
        : {}),
      toolRelevant: scenario.toolRelevant,
      prompt: scenario.prompt,
      fixture: scenario.fixture,
      check: scenario.check,
      agent: { ...scenario.agent, model },
      tool: scenario.tool,
    },
    model,
    n: opts.n,
    startedAt: now().toISOString(),
    endedAt: null,
    aborted: false,
    abortReason: null,
    conditions,
    stoppedEarly: false,
    stopReason: null,
    runDirs: [],
    harnessVersion: HARNESS_VERSION,
  };
  const writeBatch = () =>
    fs.writeFileSync(
      path.join(batchDir, "batch.json"),
      JSON.stringify(batch, null, 2) + "\n"
    );
  writeBatch();

  let consecutiveDuds = 0;
  const dudRunIds: string[] = [];

  try {
    for (const step of runOrder(opts.n, conditions)) {
      const { record, check } = await runOnce(
        scenario,
        step.condition,
        step.index,
        batchDir,
        opts
      );
      batch.runDirs.push(path.join("runs", record.runId));
      writeBatch();

      const analysis = analyzeTranscriptFile(
        path.join(batchDir, record.transcriptFile),
        scenario.tool
      );
      const zeroCost = analysis.totals.total === 0;
      log(
        `${record.runId}: exit=${record.exitCode} tokens=${analysis.totals.total} ` +
          `turns=${analysis.turns} invoked=${analysis.invoked} ` +
          `solved=${String(check.solved)} ${Math.round(record.wallClockMs / 1000)}s`
      );

      if (opts.onRunComplete) {
        const stop = opts.onRunComplete({
          runId: record.runId,
          condition: record.condition,
          index: record.index,
          tokens: analysis.totals.total,
          usd: bestEffortUsd(record.model, analysis.totals, analysis.reportedCostUsd).usd,
          invoked: analysis.invoked,
          solved: check.solved,
          wallClockMs: record.wallClockMs,
          zeroCost,
        });
        if (stop) {
          batch.stoppedEarly = true;
          batch.stopReason = stop;
          log(`batch stopped early: ${stop}`);
          break;
        }
      }

      if (zeroCost) {
        consecutiveDuds++;
        dudRunIds.push(record.runId);
        log(
          `${record.runId}: ZERO-COST RUN (${consecutiveDuds}/${DUD_GUARD_THRESHOLD}) — ` +
            `the agent produced no billable tokens. Credential remaining: ${
              record.credential.remainingHuman ?? "unknown"
            }`
        );
        if (consecutiveDuds >= DUD_GUARD_THRESHOLD) {
          throw new DudGuardError(
            `Dud guard: ${consecutiveDuds} consecutive zero-cost runs (${dudRunIds.join(
              ", "
            )}). The agent is producing nothing — most likely expired or missing ` +
              `credentials, a bad model id, or an unusable agent command. Aborting the ` +
              `batch so these rows cannot be mistaken for real failures. ` +
              `Credential source=${record.credential.source}, remaining=${
                record.credential.remainingHuman ?? "unknown"
              }. Inspect ${path.join(batchDir, record.stderrFile)}.`,
            consecutiveDuds,
            [...dudRunIds]
          );
        }
      } else {
        consecutiveDuds = 0;
      }
    }
  } catch (err) {
    batch.aborted = true;
    batch.abortReason =
      err instanceof DudGuardError ? err.message : String((err as Error).message);
    batch.endedAt = now().toISOString();
    writeBatch();
    throw err;
  }

  batch.endedAt = now().toISOString();
  writeBatch();
  return { batchDir, batch };
}
