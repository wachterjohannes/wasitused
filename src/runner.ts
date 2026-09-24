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
import * as os from "node:os";
import * as path from "node:path";
import {
  prepareIsolatedRun,
  findAncestorAgentConfig,
  inspectCredentials,
  stripInheritedAgentEnv,
  OAUTH_TOKEN_ENV,
  type CredentialSource,
} from "./isolation";
import {
  buildOpencodeArgv,
  buildOpencodeConfig,
  exportOpencodeSessions,
  normalizeOpencodeExport,
  opencodeDirs,
  opencodeEnv,
  stripOpencodeEnv,
  writeOpencodeConfig,
} from "./opencode";
import { bestEffortUsd } from "./pricing";
import { analyzeTranscriptFile, isProviderLimit } from "./transcript";
import type {
  AgentKind,
  BatchRecord,
  CheckRecord,
  Condition,
  CredentialInfo,
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

export class ProviderLimitError extends Error {
  constructor(
    message: string,
    public readonly runId: string
  ) {
    super(message);
    this.name = "ProviderLimitError";
  }
}

export class IsolationBreachError extends Error {
  constructor(
    message: string,
    public readonly runId: string,
    public readonly changed: string[]
  ) {
    super(message);
    this.name = "IsolationBreachError";
  }
}

/**
 * A cheap fingerprint of the scenario's own directory: every file's relative
 * path, size and mtime. The agent works on a copy; if the original changes
 * while a run is in flight, the agent reached outside its sandbox — into the
 * fixture it is not supposed to be able to see, or next to the check and the
 * frozen expectation that grade it.
 */
export function snapshotTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else {
        try {
          const st = fs.lstatSync(full);
          out.set(path.relative(root, full), `${st.size}:${st.mtimeMs}`);
        } catch {
          /* vanished between readdir and stat: the diff will show it */
        }
      }
    }
  };
  walk(root);
  return out;
}

export function diffTrees(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [k, v] of after) if (before.get(k) !== v) changed.push(before.has(k) ? `modified ${k}` : `added ${k}`);
  for (const k of before.keys()) if (!after.has(k)) changed.push(`removed ${k}`);
  return changed.sort();
}

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
  credential: CredentialSource;
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
  /** Overrides the scenario's agent.kind. */
  agentKind?: AgentKind;
  /**
   * opencode only: env vars that carry the model provider's credential. Their
   * presence (never their value) is recorded per run, and a run refuses to
   * start without them rather than producing a column of zero-cost failures.
   */
  providerEnv?: string[];
  /** opencode only: exports the session store after a run (tests inject a fake). */
  exportSessions?: typeof exportOpencodeSessions;
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

export function resolveAgentKind(scenario: ResolvedScenario, opts: { agentKind?: AgentKind }): AgentKind {
  return opts.agentKind ?? scenario.agent.kind ?? "claude-code";
}

/**
 * opencode takes provider credentials from the environment. There is no
 * lifetime to read, so it is recorded as unknown — never as healthy — and the
 * dud guard remains the defence against a key that stops working mid-batch.
 */
export function inspectProviderEnv(
  names: string[],
  env: NodeJS.ProcessEnv = process.env
): CredentialInfo {
  const present = names.filter((n) => typeof env[n] === "string" && env[n] !== "");
  const missing = names.filter((n) => !present.includes(n));
  return {
    source: names.length === 0 ? "none" : "provider-env",
    ...(names.length > 0 ? { origin: names.map((n) => `$${n}`).join(", ") } : {}),
    copied: false,
    lifetimeKnown: false,
    expiresAt: null,
    remainingMs: null,
    remainingHuman: null,
    expired: false,
    note:
      names.length === 0
        ? "No provider credential variable named; opencode will use whatever its config and environment provide."
        : `Provider credential from the environment (present: ${present.join(", ") || "none"}${
            missing.length ? `; MISSING: ${missing.join(", ")}` : ""
          }). No readable expiry; the dud guard is the defence.`,
  };
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
    credential: opts.credential,
    ...(opts.tmpRoot ? { tmpRoot: opts.tmpRoot } : {}),
  });

  const agentKind = resolveAgentKind(scenario, opts);
  const { env: claudeStripped, stripped: strippedClaude } = stripInheritedAgentEnv();
  let env: NodeJS.ProcessEnv;
  let argv: string[];
  let credential: CredentialInfo;
  let stripped: string[];
  let agentCommand: string;
  let opencodeEnvForExport: NodeJS.ProcessEnv | null = null;

  if (agentKind === "opencode") {
    agentCommand = opts.agentCommand ?? "opencode";
    credential = inspectProviderEnv(opts.providerEnv ?? []);
    const dirs = opencodeDirs(isolated.tempDir);
    const skillsDir = path.join(isolated.configDir, "skills");
    const append = scenario.tool.enable.appendSystemPrompt;
    const instructionFiles: string[] = [];
    if (toolEnabled && append) {
      const file = path.join(isolated.tempDir, "append-system-prompt.md");
      fs.writeFileSync(file, append + "\n");
      instructionFiles.push(file);
    }
    writeOpencodeConfig(
      dirs,
      buildOpencodeConfig({
        model,
        maxTurns: scenario.agent.maxTurns,
        skillPaths: toolEnabled && fs.existsSync(skillsDir) ? [skillsDir] : [],
        instructionFiles,
        mcpServers:
          toolEnabled && isolated.mcpConfigPath
            ? ((JSON.parse(fs.readFileSync(isolated.mcpConfigPath, "utf8")) as {
                mcpServers: Record<string, unknown>;
              }).mcpServers ?? null)
            : null,
      })
    );
    const { env: noOpencode, stripped: strippedOpencode } = stripOpencodeEnv(claudeStripped);
    stripped = [...strippedClaude, ...strippedOpencode].sort();
    env = {
      ...opencodeEnv(noOpencode, dirs),
      ...(toolEnabled ? scenario.tool.enable.env ?? {} : {}),
      // spawn() sets the child's cwd but not PWD, which it inherits from the
      // harness. opencode takes its project directory from PWD: without this it
      // ran in the harness's own repository, read the frozen expectation and
      // wrote into the source fixture. Measured, not hypothetical.
      PWD: isolated.workDir,
    };
    opencodeEnvForExport = env;
    argv = buildOpencodeArgv(scenario, model, agentCommand);
  } else {
    agentCommand = opts.agentCommand ?? "claude";
    credential = inspectCredentials(opts.credential);
    credential.copied = fs.existsSync(path.join(isolated.configDir, ".credentials.json"));
    stripped = strippedClaude;
    env = {
      ...claudeStripped,
      CLAUDE_CONFIG_DIR: isolated.configDir,
      // The only CLAUDE_* variable deliberately re-added after stripping. It is
      // the credential, not configuration, and it never reaches disk or argv.
      ...(opts.credential.kind === "oauth-token"
        ? { [OAUTH_TOKEN_ENV]: opts.credential.token }
        : {}),
      ...(toolEnabled ? scenario.tool.enable.env ?? {} : {}),
      PWD: isolated.workDir,
    };
    argv = buildAgentArgv(scenario, model, toolEnabled, isolated.mcpConfigPath, agentCommand);
  }

  const transcriptFile = path.join(runDir, "transcript.jsonl");
  const eventsFile = path.join(runDir, "opencode.events.jsonl");
  const sessionsFile = path.join(runDir, "opencode.sessions.json");
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
      // opencode's stdout is its event stream, which misses subagent sessions;
      // the transcript proper is exported from its session store below.
      transcriptFile: agentKind === "opencode" ? eventsFile : transcriptFile,
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

  let transcriptExportError: string | null = null;
  if (agentKind === "opencode" && opencodeEnvForExport) {
    const exporter = opts.exportSessions ?? exportOpencodeSessions;
    const exported = exporter(agentCommand, opencodeEnvForExport, isolated.workDir);
    transcriptExportError = exported.error;
    fs.writeFileSync(sessionsFile, JSON.stringify(exported, null, 2) + "\n");
    fs.writeFileSync(transcriptFile, normalizeOpencodeExport(exported));
  }

  const check = await runCheck(scenario, isolated.workDir);
  fs.writeFileSync(checkFile, JSON.stringify(check, null, 2) + "\n");

  // Keep the artifact: it is the ground truth the check ran against. Bulk the
  // scenario marked as regenerable is skipped, and recorded as skipped — a
  // thinned artifact that does not say so is a misleading artifact.
  const artifactExcluded = scenario.artifactExclude ?? [];
  const excludedAbs = new Set(
    artifactExcluded.map((rel) => path.resolve(isolated.workDir, rel))
  );
  let artifactError: string | null = null;
  try {
    fs.cpSync(isolated.workDir, artifactDir, {
      recursive: true,
      filter: (src) => !excludedAbs.has(path.resolve(src)),
    });
  } catch (err) {
    // A full disk must not destroy a run that already cost money to produce.
    artifactError = `artifact could not be stored: ${(err as Error).message}`;
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }

  const record: RunRecord = {
    schemaVersion: 1,
    runId,
    scenarioId: scenario.id,
    condition,
    index,
    model,
    agentKind,
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
    ...(agentKind === "opencode"
      ? {
          rawTranscriptFiles: [
            path.relative(batchDir, eventsFile),
            path.relative(batchDir, sessionsFile),
          ],
          transcriptExportError,
        }
      : {}),
    stderrFile: path.relative(batchDir, stderrFile),
    checkFile: path.relative(batchDir, checkFile),
    artifactDir: artifactError ? null : path.relative(batchDir, artifactDir),
    artifactExcluded,
    artifactError,
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
  const agentKind = resolveAgentKind(scenario, opts);
  const credential =
    agentKind === "opencode"
      ? inspectProviderEnv(opts.providerEnv ?? [])
      : inspectCredentials(opts.credential);
  log(`agent: ${agentKind}`);
  const leaking = findAncestorAgentConfig(opts.tmpRoot ?? os.tmpdir());
  if (leaking.length > 0) {
    throw new Error(
      `Refusing to run: agent configuration above the temp root would be read by every run, ` +
        `in both conditions: ${leaking.join(", ")}. Agents load these from ancestor directories. ` +
        `Point TMPDIR at a directory with no such ancestors.`
    );
  }
  if (agentKind === "opencode") {
    const missing = (opts.providerEnv ?? []).filter((n) => !process.env[n]);
    if (missing.length > 0) {
      throw new Error(
        `opencode provider credential missing from the environment: ${missing.join(", ")}. ` +
          `Refusing to start a batch that could only produce zero-cost runs.`
      );
    }
  }
  log(
    `credential: source=${credential.source}${
      credential.origin ? ` (${credential.origin})` : ""
    } remaining=${credential.remainingHuman ?? "unknown"}${
      credential.expired ? " EXPIRED" : ""
    }`
  );
  if (credential.note) log(`credential note: ${credential.note}`);

  const batch: BatchRecord = {
    schemaVersion: 1,
    batchId,
    scenarioId: scenario.id,
    scenarioConfigPath: scenario.configPath,
    scenarioSnapshot: {
      id: scenario.id,
      ...(scenario.artifactExclude ? { artifactExclude: scenario.artifactExclude } : {}),
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
    agentKind,
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
  const scenarioTree = snapshotTree(scenario.dir);

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

      const changed = diffTrees(scenarioTree, snapshotTree(scenario.dir));
      if (changed.length > 0) {
        throw new IsolationBreachError(
          `Isolation breach in ${record.runId}: the scenario's own directory changed while the ` +
            `agent ran (${changed.slice(0, 5).join("; ")}${changed.length > 5 ? "; ..." : ""}). ` +
            `The agent reached outside its working copy, so it could also have read the check or ` +
            `the frozen expectation. Aborting: no run from this batch can be trusted. ` +
            `Restore ${scenario.dir} before re-running.`,
          record.runId,
          changed
        );
      }

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

      if (isProviderLimit(analysis)) {
        throw new ProviderLimitError(
          `Provider limit in ${record.runId}: ${String(analysis.resultError ?? "").slice(0, 200)} ` +
            `(status ${analysis.resultApiErrorStatus ?? "unknown"}). The run is excluded as a ` +
            `provider error; the batch stops here, because every further run would hit the same ` +
            `cap and be excluded too. Resume once the limit has reset.`,
          record.runId
        );
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
      err instanceof DudGuardError ||
      err instanceof IsolationBreachError ||
      err instanceof ProviderLimitError
        ? err.message
        : String((err as Error).message);
    batch.endedAt = now().toISOString();
    writeBatch();
    throw err;
  }

  batch.endedAt = now().toISOString();
  writeBatch();
  return { batchDir, batch };
}
