/**
 * Isolation for the agent under test.
 *
 * The harness spawns the coding agent it is measuring. If any of the host's own
 * configuration leaks in, the numbers describe the developer's laptop rather
 * than a clean baseline. Three separate leaks are closed here:
 *
 *   1. Config: a throwaway CLAUDE_CONFIG_DIR per run, never the real one.
 *   2. Environment: every inherited CLAUDE_* variable is stripped.
 *   3. Filesystem: a fresh copy of the fixture in a temp dir, so the agent
 *      never runs inside the harness's own working tree.
 *
 * Credentials are supplied fresh per run and whatever is knowable about their
 * remaining lifetime is recorded, because an expired token produces a run that
 * looks legitimate (one turn, no cost, exit 0) but measured nothing.
 *
 * Two credential shapes are supported, and the difference is reported rather
 * than smoothed over:
 *
 *   - **A credential file** (`~/.claude/.credentials.json`), copied into the
 *     throwaway config dir. Its OAuth expiry is readable, so every run records
 *     exactly how much life the credential had left.
 *   - **A long-lived OAuth token** (from `claude setup-token`), injected as the
 *     single deliberately re-added `CLAUDE_*` variable after stripping. A bare
 *     token carries no introspectable expiry, so the lifetime is recorded as
 *     *unknown* rather than invented. Writing a made-up far-future expiry would
 *     make every run claim a healthy credential it cannot vouch for, which is
 *     precisely the signal the dud guard depends on.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CredentialInfo } from "./types";

/** Env vars that configure the agent under test and must never be inherited. */
export const AGENT_ENV_PREFIXES = ["CLAUDE_", "CLAUDECODE"];

/** The env var Claude Code reads a `claude setup-token` credential from. */
export const OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

/**
 * Where a run's credentials come from.
 *
 * `token` is held in memory and injected into the child's environment. It is
 * never written to a run record, a transcript, or an argv — a token in `ps`
 * output or a committed artifact is a leaked token.
 */
export type CredentialSource =
  | { kind: "file"; path: string }
  | { kind: "oauth-token"; token: string; origin: string };

export interface ResolveCredentialOptions {
  /** Explicit --credentials path. Wins over token auth when given. */
  credentialsPath?: string | undefined;
  /** Read the token from this env var. */
  oauthTokenEnv?: string | undefined;
  /** Read the token from the first line of this file. */
  oauthTokenFile?: string | undefined;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/**
 * Picks a credential source.
 *
 * Precedence: an explicit file, then an explicit token file, then a token in
 * the environment, then the default credential file path. A token is never
 * accepted as a command-line argument: arguments are visible to every other
 * process on the machine.
 */
export function resolveCredentialSource(
  opts: ResolveCredentialOptions = {}
): CredentialSource {
  const env = opts.env ?? process.env;

  if (opts.credentialsPath) {
    return { kind: "file", path: path.resolve(opts.credentialsPath) };
  }

  if (opts.oauthTokenFile) {
    const file = path.resolve(opts.oauthTokenFile);
    const token = fs.readFileSync(file, "utf8").trim();
    if (!token) throw new Error(`oauth token file is empty: ${file}`);
    return { kind: "oauth-token", token, origin: `file ${file}` };
  }

  const varName = opts.oauthTokenEnv ?? OAUTH_TOKEN_ENV;
  const fromEnv = env[varName];
  if (fromEnv && fromEnv.trim()) {
    return { kind: "oauth-token", token: fromEnv.trim(), origin: `$${varName}` };
  }

  return { kind: "file", path: defaultCredentialsPath(opts.home ?? os.homedir()) };
}

export interface StrippedEnv {
  env: NodeJS.ProcessEnv;
  stripped: string[];
}

export function stripInheritedAgentEnv(
  source: NodeJS.ProcessEnv = process.env
): StrippedEnv {
  const env: NodeJS.ProcessEnv = {};
  const stripped: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (AGENT_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      stripped.push(key);
      continue;
    }
    env[key] = value;
  }
  return { env, stripped: stripped.sort() };
}

export function defaultCredentialsPath(
  home: string = os.homedir()
): string {
  return path.join(home, ".claude", ".credentials.json");
}

export function humanDuration(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  let rest = Math.abs(ms);
  const hours = Math.floor(rest / 3_600_000);
  rest -= hours * 3_600_000;
  const minutes = Math.floor(rest / 60_000);
  return `${sign}${hours}h${String(minutes).padStart(2, "0")}m`;
}

/**
 * Reads the credential file without copying it, and reports how much life is
 * left. Never logs or returns token material.
 */
export function inspectCredentials(
  source: CredentialSource,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now()
): CredentialInfo {
  if (source.kind === "oauth-token") {
    return {
      source: "oauth-token",
      origin: source.origin,
      copied: false,
      lifetimeKnown: false,
      expiresAt: null,
      remainingMs: null,
      remainingHuman: null,
      expired: false,
      note:
        "Long-lived OAuth token: it carries no expiry this harness can read, so the " +
        "remaining lifetime is unknown rather than assumed healthy. If the token dies " +
        "mid-batch the dud guard is what catches it.",
    };
  }

  const credentialsPath = source.path;
  if (!fs.existsSync(credentialsPath)) {
    if (env.ANTHROPIC_API_KEY) {
      return {
        source: "env-api-key",
        copied: false,
        lifetimeKnown: false,
        expiresAt: null,
        remainingMs: null,
        remainingHuman: null,
        expired: false,
        note: "ANTHROPIC_API_KEY is set; API keys carry no expiry the harness can check.",
      };
    }
    return {
      source: "none",
      path: credentialsPath,
      copied: false,
      lifetimeKnown: false,
      expiresAt: null,
      remainingMs: null,
      remainingHuman: null,
      expired: false,
      note: "No credential file and no ANTHROPIC_API_KEY — the agent will almost certainly fail to authenticate.",
    };
  }

  let expiresAt: number | null = null;
  let note: string | undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath, "utf8")) as Record<
      string,
      unknown
    >;
    const oauth = parsed.claudeAiOauth;
    if (oauth && typeof oauth === "object") {
      const value = (oauth as Record<string, unknown>).expiresAt;
      if (typeof value === "number" && Number.isFinite(value)) expiresAt = value;
    }
    if (expiresAt === null) {
      note = "Credential file has no readable expiry field; lifetime unknown.";
    }
  } catch (err) {
    note = `Credential file could not be parsed: ${(err as Error).message}`;
  }

  const remainingMs = expiresAt === null ? null : expiresAt - now;
  return {
    source: "config-file",
    path: credentialsPath,
    copied: false,
    lifetimeKnown: expiresAt !== null,
    expiresAt,
    remainingMs,
    remainingHuman: remainingMs === null ? null : humanDuration(remainingMs),
    expired: remainingMs !== null && remainingMs <= 0,
    ...(note ? { note } : {}),
  };
}

export function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true, dereference: true });
}

export interface IsolatedRun {
  tempDir: string;
  configDir: string;
  workDir: string;
  mcpConfigPath: string | null;
  cleanup(): void;
}

export interface PrepareOptions {
  scenarioId: string;
  condition: string;
  index: number;
  fixturePath: string;
  scenarioDir: string;
  toolEnabled: boolean;
  skills?: string[];
  fixtureFiles?: string[];
  mcpServers?: Record<string, unknown>;
  credential: CredentialSource;
  /** Overridable so tests never touch the real temp root of a live batch. */
  tmpRoot?: string;
}

/**
 * Builds a throwaway config dir + fixture working copy under the OS temp dir.
 * Deliberately NOT under the harness repo: the agent must never be able to see
 * or edit the harness's own source.
 */
export function prepareIsolatedRun(opts: PrepareOptions): IsolatedRun {
  const root = opts.tmpRoot ?? os.tmpdir();
  const tempDir = fs.mkdtempSync(
    path.join(root, `wasitused-${opts.scenarioId}-${opts.condition}-${opts.index}-`)
  );
  const configDir = path.join(tempDir, "config");
  const workDir = path.join(tempDir, "work");
  fs.mkdirSync(configDir, { recursive: true });

  // A bare config dir: no host CLAUDE.md, no host skills, no host memory.
  fs.writeFileSync(
    path.join(configDir, "settings.json"),
    JSON.stringify({ includeCoAuthoredBy: false }, null, 2) + "\n"
  );

  // A token is injected into the child's environment instead, never to disk.
  if (opts.credential.kind === "file" && fs.existsSync(opts.credential.path)) {
    const target = path.join(configDir, ".credentials.json");
    fs.copyFileSync(opts.credential.path, target);
    fs.chmodSync(target, 0o600);
  }

  copyDir(opts.fixturePath, workDir);

  if (opts.toolEnabled) {
    for (const skill of opts.skills ?? []) {
      const from = path.resolve(opts.scenarioDir, skill);
      const to = path.join(configDir, "skills", path.basename(from));
      copyDir(from, to);
    }
    for (const file of opts.fixtureFiles ?? []) {
      const from = path.resolve(opts.scenarioDir, file);
      const to = path.join(workDir, path.basename(from));
      if (fs.statSync(from).isDirectory()) copyDir(from, to);
      else fs.copyFileSync(from, to);
    }
  }

  let mcpConfigPath: string | null = null;
  if (opts.toolEnabled && opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
    mcpConfigPath = path.join(tempDir, "mcp.json");
    // Server paths in the scenario are relative to the scenario dir; make them
    // absolute so the agent's own cwd (the fixture copy) cannot change meaning.
    const resolved = JSON.parse(
      JSON.stringify(opts.mcpServers).replace(
        /"\.\/([^"]*)"/g,
        (_m, rel: string) =>
          JSON.stringify(path.resolve(opts.scenarioDir, rel))
      )
    ) as Record<string, unknown>;
    fs.writeFileSync(
      mcpConfigPath,
      JSON.stringify({ mcpServers: resolved }, null, 2) + "\n"
    );
  }

  return {
    tempDir,
    configDir,
    workDir,
    mcpConfigPath,
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}
