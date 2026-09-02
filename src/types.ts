/** Shared types. Everything the harness writes to disk is typed here. */

export type Condition = "with_tool" | "baseline";

export const CONDITIONS: Condition[] = ["with_tool", "baseline"];

/** How the tool under test is switched on. All paths are relative to the scenario file. */
export interface ToolEnable {
  /** Directories copied into <CLAUDE_CONFIG_DIR>/skills/<basename>. */
  skills?: string[];
  /** Written to a temp mcp config and passed via --mcp-config --strict-mcp-config. */
  mcpServers?: Record<string, unknown>;
  /** Extra env vars for the agent process. */
  env?: Record<string, string>;
  /** Files/dirs copied into the agent's working copy of the fixture. */
  fixtureFiles?: string[];
  /** Appended to the agent's system prompt. */
  appendSystemPrompt?: string;
}

/**
 * How an *actual invocation* is recognised in the transcript.
 * Deliberately separate from `documentation` — reading the docs is not using the tool.
 */
export interface ToolInvocationMatchers {
  /** Tool-call names; a trailing `*` is a prefix wildcard (e.g. "mcp__phrasebook__*"). */
  toolNames?: string[];
  /** Regexes matched against the `command` input of a Bash tool call. */
  bashPatterns?: string[];
  /** Skill names matched against a Skill tool call. */
  skillNames?: string[];
}

export interface ToolDocumentationMatchers {
  /** Regexes matched against path-ish inputs of Read/Glob/Grep calls. */
  pathPatterns?: string[];
  /**
   * Skill names whose *loading* only pulls documentation into context.
   * Loading an Agent Skill that describes a CLI is reading the docs; running
   * the CLI it describes is the invocation. Put the skill here and the command
   * in `invocation`, or the two events collapse into one.
   */
  skillNames?: string[];
}

export interface ToolUnderTest {
  name: string;
  enable: ToolEnable;
  invocation: ToolInvocationMatchers;
  documentation?: ToolDocumentationMatchers;
}

export interface AgentConfig {
  /** Pinned model id. Determinism beats convenience — always pin it. */
  model: string;
  maxTurns: number;
  /** Hard wall-clock kill for a single agent process. */
  timeoutMs: number;
}

export interface SuccessCheck {
  /** Shell command, run with cwd = the agent's working copy of the fixture. */
  command: string;
  timeoutMs: number;
}

export interface ScenarioConfig {
  id: string;
  description?: string;
  /**
   * false = the tool cannot help here. Those scenarios exist to measure over-use;
   * an efficacy delta is not expected and is not reported as a win.
   */
  toolRelevant: boolean;
  prompt: string;
  fixture: string;
  /**
   * Paths (relative to the agent's working copy) left out of the persisted
   * artifact. For regenerable bulk like `vendor/` or `var/cache` — the agent
   * still gets them, they just are not copied into every stored run. What was
   * excluded is recorded per run so a thinned artifact is never mistaken for a
   * complete one.
   */
  artifactExclude?: string[];
  check: SuccessCheck;
  agent: AgentConfig;
  tool: ToolUnderTest;
}

/** A scenario with every path resolved against the scenario file's directory. */
export interface ResolvedScenario extends ScenarioConfig {
  configPath: string;
  dir: string;
  fixturePath: string;
}

export interface CredentialInfo {
  /** Where the harness got the agent's credentials from. */
  source: "config-file" | "env-api-key" | "oauth-token" | "none";
  path?: string;
  /** Human-readable provenance for token auth, e.g. "$CLAUDE_CODE_OAUTH_TOKEN". */
  origin?: string;
  copied: boolean;
  /**
   * Whether the remaining lifetime could actually be read. false means unknown,
   * which is not the same as healthy — a bare token has no readable expiry.
   */
  lifetimeKnown: boolean;
  expiresAt: number | null;
  remainingMs: number | null;
  remainingHuman: string | null;
  expired: boolean;
  note?: string;
}

/** One agent run, written to <runDir>/run.json. */
export interface RunRecord {
  schemaVersion: 1;
  runId: string;
  scenarioId: string;
  condition: Condition;
  index: number;
  model: string;
  maxTurns: number;
  toolEnabled: boolean;
  startedAt: string;
  endedAt: string;
  wallClockMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Recorded per run — an expired token produces a run that *looks* legitimate. */
  credential: CredentialInfo;
  argv: string[];
  envKeysStripped: string[];
  transcriptFile: string;
  stderrFile: string;
  checkFile: string;
  artifactDir: string | null;
  /** Paths deliberately left out of the artifact, so it reads as partial. */
  artifactExcluded: string[];
  /** Set when the artifact could not be stored at all (e.g. no disk space). */
  artifactError: string | null;
  tempDir: string;
}

/** Result of the scenario's own success check, written to <runDir>/check.json. */
export interface CheckRecord {
  /** null means "could not be determined" — never coerced to false. */
  solved: boolean | null;
  reason: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

/** Batch manifest, written to <batchDir>/batch.json. */
export interface BatchRecord {
  schemaVersion: 1;
  batchId: string;
  scenarioId: string;
  scenarioConfigPath: string;
  scenarioSnapshot: ScenarioConfig;
  model: string;
  n: number;
  startedAt: string;
  endedAt: string | null;
  aborted: boolean;
  abortReason: string | null;
  /** Conditions this batch was configured to run. A pilot runs baseline only. */
  conditions: Condition[];
  /** True when a budget hook ended the batch cleanly before all runs finished. */
  stoppedEarly: boolean;
  stopReason: string | null;
  runDirs: string[];
  harnessVersion: string;
}
