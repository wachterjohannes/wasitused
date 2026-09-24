/**
 * opencode as the agent under test.
 *
 * Three things differ from Claude Code, and each one is handled rather than
 * assumed away:
 *
 * 1. **Where configuration comes from.** opencode reads its config from
 *    `$XDG_CONFIG_HOME/opencode`, its sessions from `$XDG_DATA_HOME`, and —
 *    measured, not guessed — skills from `~/.claude/skills` in `$HOME`, not only
 *    from the project. An empty `XDG_CONFIG_HOME` alone therefore still leaks
 *    the operator's global skills into every run. Each run gets its own HOME and
 *    all four XDG directories.
 *
 * 2. **Where the transcript is.** `opencode run --format json` streams events for
 *    the top-level session only. Work delegated to a subagent (the `task` tool)
 *    runs in a child session whose tokens never appear on stdout. The complete
 *    record is opencode's own session store, so the run is exported from there
 *    with `opencode db` after the process exits, child sessions included.
 *
 * 3. **The transcript shape.** The export is normalized into the same event
 *    shape the Claude Code parser reads — assistant messages with usage and
 *    tool_use blocks, tool_result blocks, a terminal result line — so metrics,
 *    the dud guard and shell-health detection run unchanged on both agents.
 *    Tool names are mapped (`bash` -> `Bash`, `read` -> `Read`, `skill` ->
 *    `Skill`, ...); the original name is kept on every block. The raw stdout
 *    events and the raw export are stored next to it, so the normalization can
 *    always be re-checked against what opencode actually wrote.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedScenario } from "./types";

/** Inherited env vars that configure opencode itself and must never leak in. */
export const OPENCODE_ENV_PREFIXES = ["OPENCODE_"];

/** opencode tool name -> the Claude Code name the transcript parser matches on. */
export const OPENCODE_TOOL_NAMES: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  multiedit: "MultiEdit",
  patch: "Edit",
  grep: "Grep",
  glob: "Glob",
  list: "Glob",
  skill: "Skill",
  task: "Task",
  todowrite: "TodoWrite",
  todoread: "TodoRead",
  webfetch: "WebFetch",
};

/** opencode input field -> the Claude Code field the parser reads. */
const INPUT_FIELD_MAP: Record<string, string> = {
  filePath: "file_path",
};

export interface OpencodeDirs {
  home: string;
  configHome: string;
  dataHome: string;
  stateHome: string;
  cacheHome: string;
}

export function opencodeDirs(tempDir: string): OpencodeDirs {
  return {
    home: path.join(tempDir, "home"),
    configHome: path.join(tempDir, "xdg-config"),
    dataHome: path.join(tempDir, "xdg-data"),
    stateHome: path.join(tempDir, "xdg-state"),
    cacheHome: path.join(tempDir, "xdg-cache"),
  };
}

export interface OpencodeConfigInput {
  model: string;
  maxTurns: number;
  /** Absolute skill directories to expose, or none. */
  skillPaths: string[];
  /** Absolute instruction files appended to the system prompt, or none. */
  instructionFiles: string[];
  /** Claude-Code-shaped MCP servers ({command, args, env}) to translate. */
  mcpServers: Record<string, unknown> | null;
}

/**
 * The per-run opencode config.
 *
 * Deliberately switched off, in both conditions alike: auto-update, sharing,
 * LSP servers (downloaded into the fresh HOME on first use — slow, networked,
 * and a source of run-to-run variance unrelated to the tool), formatters (they
 * rewrite files the success check grades) and snapshots. The small model used
 * for session titles is pinned to the run's model so no second provider or
 * model is ever contacted.
 */
export function buildOpencodeConfig(input: OpencodeConfigInput): Record<string, unknown> {
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    lsp: false,
    formatter: false,
    snapshot: false,
    model: input.model,
    small_model: input.model,
    agent: { build: { steps: input.maxTurns } },
    // --auto approves every permission not explicitly denied, including reads
    // outside the project. Measured: an agent grepped "/" from its sandbox,
    // which reaches the harness's own checks and expectations. Denied here, in
    // both conditions; the harness also excludes any run that saw the scenario
    // directory, whatever route it took.
    permission: { external_directory: "deny" },
  };
  if (input.skillPaths.length > 0) config.skills = { paths: input.skillPaths };
  if (input.instructionFiles.length > 0) config.instructions = input.instructionFiles;
  if (input.mcpServers && Object.keys(input.mcpServers).length > 0) {
    const mcp: Record<string, unknown> = {};
    for (const [name, raw] of Object.entries(input.mcpServers)) {
      const server = (raw ?? {}) as Record<string, unknown>;
      if (typeof server.url === "string") {
        mcp[name] = { type: "remote", url: server.url, enabled: true };
        continue;
      }
      const command = typeof server.command === "string" ? [server.command] : [];
      const args = Array.isArray(server.args) ? server.args.map(String) : [];
      mcp[name] = {
        type: "local",
        command: [...command, ...args],
        enabled: true,
        ...(server.env && typeof server.env === "object" ? { environment: server.env } : {}),
      };
    }
    config.mcp = mcp;
  }
  return config;
}

export function writeOpencodeConfig(dirs: OpencodeDirs, config: Record<string, unknown>): string {
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dirs.configHome, "opencode", "opencode.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return file;
}

export function stripOpencodeEnv(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; stripped: string[] } {
  const out: NodeJS.ProcessEnv = {};
  const stripped: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (OPENCODE_ENV_PREFIXES.some((p) => key.startsWith(p))) {
      stripped.push(key);
      continue;
    }
    out[key] = value;
  }
  return { env: out, stripped: stripped.sort() };
}

/** Points every place opencode reads from or writes to at the run's temp dirs. */
export function opencodeEnv(base: NodeJS.ProcessEnv, dirs: OpencodeDirs): NodeJS.ProcessEnv {
  return {
    ...base,
    HOME: dirs.home,
    XDG_CONFIG_HOME: dirs.configHome,
    XDG_DATA_HOME: dirs.dataHome,
    XDG_STATE_HOME: dirs.stateHome,
    XDG_CACHE_HOME: dirs.cacheHome,
  };
}

export function buildOpencodeArgv(
  scenario: ResolvedScenario,
  model: string,
  agentCommand = "opencode"
): string[] {
  // --auto approves tool permissions that are not explicitly denied: an
  // unattended run has nobody to answer a prompt, and a hung prompt would look
  // like a slow agent. Claude Code runs with bypassPermissions for the same reason.
  return [agentCommand, "run", "--model", model, "--format", "json", "--auto", scenario.prompt];
}

interface DbRow {
  [key: string]: unknown;
}

export interface OpencodeExport {
  sessions: DbRow[];
  messages: DbRow[];
  parts: DbRow[];
  error: string | null;
}

/**
 * Reads the finished run's sessions back out of opencode's own store, with
 * opencode's own `db` command, so the harness takes no SQLite dependency and
 * reads exactly what opencode recorded.
 */
export function exportOpencodeSessions(
  agentCommand: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  run: typeof spawnSync = spawnSync
): OpencodeExport {
  const query = (sql: string): DbRow[] => {
    const res = run(agentCommand, ["db", sql, "--format", "json"], {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      timeout: 120_000,
    });
    if (res.error) throw res.error;
    if (res.status !== 0) {
      throw new Error(`opencode db exited ${res.status}: ${String(res.stderr).slice(0, 500)}`);
    }
    const text = String(res.stdout).trim();
    if (text === "") return [];
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error("opencode db did not return a JSON array");
    return parsed as DbRow[];
  };
  try {
    return {
      sessions: query("select id, parent_id, title, time_created from session order by time_created"),
      messages: query("select id, session_id, time_created, data from message order by time_created, id"),
      parts: query("select id, message_id, session_id, time_created, data from part order by time_created, id"),
      error: null,
    };
  } catch (err) {
    return { sessions: [], messages: [], parts: [], error: (err as Error).message };
  }
}

function parseData(row: DbRow): Record<string, unknown> {
  const raw = row.data;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return {};
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function mapInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[INPUT_FIELD_MAP[k] ?? k] = v;
    if (INPUT_FIELD_MAP[k]) out[k] = v;
  }
  return out;
}

/**
 * Normalizes an export into Claude-Code-shaped JSONL.
 *
 * - One `assistant` line per opencode assistant message, id = the message id,
 *   usage from opencode's own token counts: `input` -> input_tokens,
 *   `output + reasoning` -> output_tokens, cache read/write -> the cache fields.
 * - Each completed or failed tool part becomes a tool_use block on its message
 *   and a tool_result in a following `user` line. A bash call that exited
 *   non-zero is an error, as it is in Claude Code; opencode itself marks it
 *   `completed` and keeps the exit code in metadata.
 * - A terminal `result` line carries the sum over every session, subagents
 *   included, and opencode's own cost figure. It is emitted only when the
 *   export succeeded and at least one assistant message exists; a run with no
 *   recorded work must stay zero-cost so the dud guard can see it.
 */
export function normalizeOpencodeExport(exp: OpencodeExport): string {
  const lines: string[] = [];
  const partsByMessage = new Map<string, Record<string, unknown>[]>();
  for (const row of exp.parts) {
    const data = parseData(row);
    const mid = String(row.message_id ?? data.messageID ?? "");
    const list = partsByMessage.get(mid) ?? [];
    list.push(data);
    partsByMessage.set(mid, list);
  }
  const parentOf = new Map<string, string | null>();
  for (const s of exp.sessions) parentOf.set(String(s.id), (s.parent_id as string | null) ?? null);

  const total = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let cost = 0;
  let assistantCount = 0;
  let lastError: string | null = null;
  let lastErrorName: string | null = null;
  let lastErrorStatus: number | null = null;

  for (const row of exp.messages) {
    const msg = parseData(row);
    if (msg.role !== "assistant") continue;
    assistantCount++;
    const id = String(row.id);
    const sessionId = String(row.session_id ?? msg.sessionID ?? "");
    const tokens = (msg.tokens ?? {}) as Record<string, unknown>;
    const cache = (tokens.cache ?? {}) as Record<string, unknown>;
    const usage = {
      input_tokens: num(tokens.input),
      output_tokens: num(tokens.output) + num(tokens.reasoning),
      cache_read_input_tokens: num(cache.read),
      cache_creation_input_tokens: num(cache.write),
    };
    total.input += usage.input_tokens;
    total.output += usage.output_tokens;
    total.cacheRead += usage.cache_read_input_tokens;
    total.cacheCreation += usage.cache_creation_input_tokens;
    cost += num(msg.cost);
    if (msg.error && typeof msg.error === "object") {
      const e = msg.error as Record<string, unknown>;
      const data = (e.data ?? {}) as Record<string, unknown>;
      lastError = String(data.message ?? e.name ?? "error");
      lastErrorName = typeof e.name === "string" ? e.name : null;
      lastErrorStatus = typeof data.statusCode === "number" ? data.statusCode : null;
    }

    const content: Record<string, unknown>[] = [];
    const results: Record<string, unknown>[] = [];
    for (const part of partsByMessage.get(id) ?? []) {
      if (part.type === "text" && typeof part.text === "string") {
        content.push({ type: "text", text: part.text });
        continue;
      }
      if (part.type !== "tool") continue;
      const state = (part.state ?? {}) as Record<string, unknown>;
      const status = String(state.status ?? "");
      if (status !== "completed" && status !== "error") continue;
      const opName = String(part.tool ?? "");
      const blockId = String(part.callID ?? part.id ?? `${id}#${content.length}`);
      content.push({
        type: "tool_use",
        id: blockId,
        name: OPENCODE_TOOL_NAMES[opName] ?? opName,
        opencode_tool: opName,
        input: mapInput(state.input),
      });
      const metadata = (state.metadata ?? {}) as Record<string, unknown>;
      const exit = metadata.exit;
      const isError =
        status === "error" || (opName === "bash" && typeof exit === "number" && exit !== 0);
      const output =
        status === "error" ? String(state.error ?? "") : String(state.output ?? "");
      results.push({
        type: "tool_result",
        tool_use_id: blockId,
        content: output,
        ...(isError ? { is_error: true } : {}),
      });
    }
    lines.push(
      JSON.stringify({
        type: "assistant",
        session_id: sessionId,
        parent_session_id: parentOf.get(sessionId) ?? null,
        message: { id, role: "assistant", model: msg.modelID ?? null, content, usage },
      })
    );
    if (results.length > 0) {
      lines.push(JSON.stringify({ type: "user", message: { role: "user", content: results } }));
    }
  }

  if (exp.error === null && assistantCount > 0) {
    lines.push(
      JSON.stringify({
        type: "result",
        subtype: lastError ? "error" : "success",
        is_error: lastError !== null,
        ...(lastError ? { error: lastError } : {}),
        ...(lastErrorName ? { error_name: lastErrorName } : {}),
        ...(lastErrorStatus !== null ? { api_error_status: lastErrorStatus } : {}),
        usage: {
          input_tokens: total.input,
          output_tokens: total.output,
          cache_read_input_tokens: total.cacheRead,
          cache_creation_input_tokens: total.cacheCreation,
        },
        total_cost_usd: cost,
        sessions: exp.sessions.length,
        source: "opencode-session-store",
      })
    );
  }
  return lines.length > 0 ? lines.join("\n") + "\n" : "";
}
