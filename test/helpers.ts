/** Fixture builders shared by the tests. No tests live in this file. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  BatchRecord,
  CheckRecord,
  Condition,
  ResolvedScenario,
  RunRecord,
  ScenarioConfig,
  ToolUnderTest,
} from "../src/types";

export const TOOL: ToolUnderTest = {
  name: "phrasebook",
  enable: {
    skills: ["../phrasebook-tool/skills/phrasebook"],
    fixtureFiles: ["../phrasebook-tool/tools"],
  },
  invocation: { bashPatterns: ["tools[/\\\\]phrasebook"] },
  documentation: { pathPatterns: ["phrasebook[/\\\\]SKILL\\.md"] },
};

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `wasitused-test-${prefix}-`));
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export function initLine(model = "claude-opus-5"): string {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "sess_test",
    model,
  });
}

export function assistantLine(
  id: string,
  usage: Usage,
  content: unknown[] = [{ type: "text", text: "working" }]
): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        ...usage,
      },
    },
  });
}

export function bashCall(id: string, command: string): unknown {
  return { type: "tool_use", id, name: "Bash", input: { command } };
}

export function readCall(id: string, filePath: string): unknown {
  return { type: "tool_use", id, name: "Read", input: { file_path: filePath } };
}

/**
 * The terminal line. Its usage is the authoritative total for the run, so by
 * default it is left absent and the deduped message totals stand — tests that
 * care about the result-line path pass one explicitly.
 */
export function resultLine(
  subtype = "success",
  isError = false,
  usage: Usage | null = null,
  costUsd: number | null = null
): string {
  return JSON.stringify({
    type: "result",
    subtype,
    is_error: isError,
    num_turns: 2,
    ...(costUsd === null ? {} : { total_cost_usd: costUsd }),
    ...(usage === null ? {} : { usage }),
  });
}

export function transcript(lines: string[]): string {
  return lines.join("\n") + "\n";
}

export function scenarioConfig(
  over: Partial<ScenarioConfig> = {}
): ScenarioConfig {
  return {
    id: "example",
    toolRelevant: true,
    prompt: "do the thing",
    fixture: "fixture",
    check: { command: "true", timeoutMs: 1000 },
    agent: { model: "claude-opus-5", maxTurns: 10, timeoutMs: 5000 },
    tool: TOOL,
    ...over,
  };
}

/** Builds a real scenario directory (fixture + check) on disk. */
export function makeScenarioDir(
  root: string,
  over: Partial<ScenarioConfig> = {}
): ResolvedScenario {
  const dir = path.join(root, "scenario");
  fs.mkdirSync(path.join(dir, "fixture"), { recursive: true });
  fs.writeFileSync(path.join(dir, "fixture", "app.txt"), "original\n");

  // The tool under test, at the paths TOOL.enable points to (../phrasebook-tool).
  const toolRoot = path.join(root, "phrasebook-tool");
  fs.mkdirSync(path.join(toolRoot, "skills", "phrasebook"), { recursive: true });
  fs.writeFileSync(
    path.join(toolRoot, "skills", "phrasebook", "SKILL.md"),
    "# phrasebook\n"
  );
  fs.mkdirSync(path.join(toolRoot, "tools"), { recursive: true });
  fs.writeFileSync(path.join(toolRoot, "tools", "phrasebook"), "#!/bin/sh\nexit 0\n");

  const config = scenarioConfig(over);
  const configPath = path.join(dir, "scenario.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return {
    ...config,
    configPath,
    dir,
    fixturePath: path.join(dir, "fixture"),
  };
}

export interface FakeRun {
  condition: Condition;
  index: number;
  transcript: string;
  check: Partial<CheckRecord>;
  record?: Partial<RunRecord>;
}

/** Writes a batch directory exactly as the runner would have left it. */
export function makeBatchDir(
  root: string,
  runs: FakeRun[],
  batchOver: Partial<BatchRecord> = {},
  scenarioOver: Partial<ScenarioConfig> = {}
): string {
  const batchDir = path.join(root, "batch");
  fs.mkdirSync(path.join(batchDir, "runs"), { recursive: true });

  const runDirs: string[] = [];
  for (const run of runs) {
    const runId = `${run.condition}-${String(run.index).padStart(3, "0")}`;
    const rel = path.join("runs", runId);
    const abs = path.join(batchDir, rel);
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(path.join(abs, "transcript.jsonl"), run.transcript);
    fs.writeFileSync(path.join(abs, "agent.stderr.log"), "");
    const check: CheckRecord = {
      solved: null,
      reason: "test",
      command: "true",
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      stdout: "",
      stderr: "",
      ...run.check,
    };
    fs.writeFileSync(path.join(abs, "check.json"), JSON.stringify(check, null, 2));
    const record: RunRecord = {
      schemaVersion: 1,
      runId,
      scenarioId: "example",
      condition: run.condition,
      index: run.index,
      model: "claude-opus-5",
      maxTurns: 10,
      toolEnabled: run.condition === "with_tool",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:01:00.000Z",
      wallClockMs: 60000,
      exitCode: 0,
      signal: null,
      timedOut: false,
      credential: {
        source: "config-file",
        copied: true,
        lifetimeKnown: true,
        expiresAt: 4102444800000,
        remainingMs: 3600000,
        remainingHuman: "1h00m",
        expired: false,
      },
      argv: ["claude", "-p", "do the thing"],
      envKeysStripped: ["CLAUDECODE"],
      transcriptFile: path.join(rel, "transcript.jsonl"),
      stderrFile: path.join(rel, "agent.stderr.log"),
      checkFile: path.join(rel, "check.json"),
      artifactDir: null,
      artifactExcluded: [],
      artifactError: null,
      tempDir: "/tmp/gone",
      ...run.record,
    };
    fs.writeFileSync(path.join(abs, "run.json"), JSON.stringify(record, null, 2));
    runDirs.push(rel);
  }

  const batch: BatchRecord = {
    schemaVersion: 1,
    batchId: "batch-test",
    scenarioId: "example",
    scenarioConfigPath: "/nowhere/scenario.json",
    scenarioSnapshot: scenarioConfig(scenarioOver),
    model: "claude-opus-5",
    n: runs.length / 2,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T01:00:00.000Z",
    aborted: false,
    abortReason: null,
    conditions: [...new Set(runs.map((r) => r.condition))],
    stoppedEarly: false,
    stopReason: null,
    runDirs,
    harnessVersion: "0.1.0",
    ...batchOver,
  };
  fs.writeFileSync(
    path.join(batchDir, "batch.json"),
    JSON.stringify(batch, null, 2)
  );
  return batchDir;
}
