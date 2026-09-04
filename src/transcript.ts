/**
 * Transcript parsing.
 *
 * Three things here are easy to get subtly wrong, so they are pinned by tests:
 *
 * 1. Claude Code's streaming transcript repeats the *cumulative* usage for a
 *    message across chunks. Summing every `usage` block overcounts badly. Usage
 *    is therefore keyed by `message.id` and only the largest observation per id
 *    is kept.
 * 2. Those per-message snapshots are still taken mid-generation, so their
 *    `output_tokens` under-report the finished message — measured against a
 *    real run, deduped message usage reproduced input and cache tokens exactly
 *    but showed 41 output tokens where the run's own terminal `result` line
 *    reported 2411. The `result` line is therefore authoritative when present,
 *    and deduped message usage is the fallback for runs killed before it, with
 *    which source was used recorded either way.
 * 3. "Read the docs about the tool" is not "invoked the tool". They are
 *    classified as two separate event kinds and never merged.
 */

import * as fs from "node:fs";
import { emptyTotals, type TokenTotals } from "./pricing";
import type { ToolUnderTest } from "./types";

export type ToolEventKind = "invocation" | "documentation";

export interface ToolEvent {
  kind: ToolEventKind;
  /**
   * Whether the tool call came back an error. null when the outcome is not
   * knowable — no result was recorded, or the shell masked the exit status
   * (see `statusMasked`). null is never the same as success.
   */
  failed: boolean | null;
  /**
   * True when the tool ran inside a shell construct whose exit status is not
   * the tool's own — `mate tools:call x | head` exits with head's status, so a
   * failing tool reports success. Measured in the wild: a tool that failed
   * 100% of the time showed a 27% failure rate purely because agents piped it
   * three quarters of the time. Masked calls are counted as unknown, never as
   * successes.
   */
  statusMasked: boolean;
  /** The transcript tool-call name, e.g. "Bash" or "mcp__phrasebook__lookup". */
  toolName: string;
  /** Why the matcher fired — kept so a report can show its work. */
  matchedBy: string;
  /** tool_use block id; used to dedupe streaming repeats. */
  blockId: string;
  messageId: string | null;
  detail: string;
}

export type TotalsSource = "result-line" | "deduped-messages";

export interface TranscriptAnalysis {
  file: string;
  exists: boolean;
  /** false => this run cannot be trusted for metrics; solved must be reported as null. */
  parseable: boolean;
  /** true when a terminal `result` line was seen. */
  complete: boolean;
  parseErrors: string[];
  totalLines: number;
  parsedLines: number;
  malformedLines: number;
  /** Distinct assistant messages — the turn count, after dedup. */
  turns: number;
  /** Best available token totals. See `totalsSource`. */
  totals: TokenTotals;
  /** Which of the two sources `totals` came from. */
  totalsSource: TotalsSource;
  /** Per-message usage after dedup. Exact for input/cache, low for output. */
  messageTotals: TokenTotals;
  /** The run's own terminal usage report, when it got that far. */
  resultTotals: TokenTotals | null;
  /**
   * The agent's own list-price cost figure. Covers every model the run touched,
   * including auxiliary ones the harness's price table cannot see.
   */
  reportedCostUsd: number | null;
  resultSubtype: string | null;
  resultIsError: boolean | null;
  events: ToolEvent[];
  invocationCount: number;
  /**
   * Invocations whose result came back an error. Adoption still counts these:
   * the agent DID call the tool. But "they called it and it broke" is a very
   * different message for a tool author than "they called it and it worked",
   * so the two are never collapsed.
   */
  invocationFailures: number;
  /**
   * Invocations whose outcome could not be established — no result recorded,
   * or the shell masked the exit status. These are excluded from the failure
   * rate's denominator rather than counted as successes.
   */
  invocationStatusUnknown: number;
  /** Invocations with a knowable outcome. The only honest denominator. */
  invocationDeterminate: number;
  documentationCount: number;
  invoked: boolean;
  readDocs: boolean;
}

const READ_LIKE_TOOLS = new Set(["Read", "Glob", "Grep", "NotebookRead"]);
const PATH_INPUT_FIELDS = ["file_path", "path", "notebook_path", "pattern", "glob"];

function matchesToolName(name: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    if (pattern.endsWith("*")) {
      if (name.startsWith(pattern.slice(0, -1))) return `toolNames:${pattern}`;
    } else if (name === pattern) {
      return `toolNames:${pattern}`;
    }
  }
  return null;
}

/**
 * Does this shell command's exit status still belong to the tool?
 *
 * Deliberately conservative: any pipeline or command separator makes the
 * answer "cannot tell", even in cases where the status would in fact survive.
 * Over-reporting "unknown" costs a little precision; under-reporting it
 * invents successes, which is the failure this exists to prevent.
 */
export function exitStatusMasked(command: string): boolean {
  // Strip quoted spans so separators inside string literals do not count.
  const bare = command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  return /\|\||\||;|&&/.test(bare);
}

function classifyToolUse(
  toolName: string,
  input: Record<string, unknown>,
  tool: ToolUnderTest
): { kind: ToolEventKind; matchedBy: string; detail: string; statusMasked?: boolean } | null {
  // Invocation wins: a call is a call, even if the path also looks like docs.
  const byName = matchesToolName(toolName, tool.invocation.toolNames ?? []);
  if (byName) {
    return { kind: "invocation", matchedBy: byName, detail: toolName };
  }

  if (toolName === "Bash" && typeof input.command === "string") {
    for (const pattern of tool.invocation.bashPatterns ?? []) {
      if (new RegExp(pattern).test(input.command)) {
        return {
          kind: "invocation",
          matchedBy: `bashPatterns:${pattern}`,
          detail: input.command.slice(0, 200),
          statusMasked: exitStatusMasked(input.command),
        };
      }
    }
  }

  if (toolName === "Skill") {
    const skill = input.skill ?? input.name ?? input.command;
    if (typeof skill === "string") {
      for (const wanted of tool.invocation.skillNames ?? []) {
        if (skill === wanted) {
          return {
            kind: "invocation",
            matchedBy: `skillNames:${wanted}`,
            detail: skill,
          };
        }
      }
    }
  }

  // Listing or inspecting a CLI tool surface describes it without using it.
  // Reached only after the invocation matchers above have declined.
  if (toolName === "Bash" && typeof input.command === "string") {
    for (const pattern of tool.documentation?.bashPatterns ?? []) {
      if (new RegExp(pattern).test(input.command)) {
        return {
          kind: "documentation",
          matchedBy: `documentation.bashPatterns:${pattern}`,
          detail: input.command.slice(0, 200),
        };
      }
    }
  }

  // Loading a skill that merely documents the tool is a docs read, not a call.
  if (toolName === "Skill") {
    const skill = input.skill ?? input.name ?? input.command;
    if (typeof skill === "string") {
      for (const wanted of tool.documentation?.skillNames ?? []) {
        if (skill === wanted) {
          return {
            kind: "documentation",
            matchedBy: `documentation.skillNames:${wanted}`,
            detail: `Skill ${skill}`,
          };
        }
      }
    }
  }

  const docPatterns = tool.documentation?.pathPatterns ?? [];
  if (docPatterns.length > 0 && READ_LIKE_TOOLS.has(toolName)) {
    for (const field of PATH_INPUT_FIELDS) {
      const value = input[field];
      if (typeof value !== "string") continue;
      for (const pattern of docPatterns) {
        if (new RegExp(pattern).test(value)) {
          return {
            kind: "documentation",
            matchedBy: `pathPatterns:${pattern}`,
            detail: `${toolName} ${value}`,
          };
        }
      }
    }
  }

  return null;
}

function readUsage(usage: Record<string, unknown> | undefined): TokenTotals | null {
  if (!usage || typeof usage !== "object") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const totals: TokenTotals = {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheCreation: num(usage.cache_creation_input_tokens),
    total: 0,
  };
  totals.total =
    totals.input + totals.output + totals.cacheRead + totals.cacheCreation;
  return totals;
}

export function analyzeTranscriptText(
  text: string,
  tool: ToolUnderTest,
  file = "<memory>"
): TranscriptAnalysis {
  const parseErrors: string[] = [];
  const lines = text.split("\n");
  // A trailing newline is normal; a trailing partial line is a truncation.
  const meaningful = lines.filter((l, i) => !(i === lines.length - 1 && l === ""));

  let parsedLines = 0;
  let malformedLines = 0;
  let complete = false;
  let resultSubtype: string | null = null;
  let resultIsError: boolean | null = null;
  let reportedTotals: TokenTotals | null = null;
  let reportedCostUsd: number | null = null;

  /** message.id -> largest usage observation for that message. */
  const usageByMessage = new Map<string, TokenTotals>();
  const seenBlockIds = new Set<string>();
  const events: ToolEvent[] = [];
  /** tool_use_id -> did the result come back an error. */
  const resultErrors = new Map<string, boolean>();

  for (let i = 0; i < meaningful.length; i++) {
    const line = meaningful[i] as string;
    if (line.trim() === "") continue;
    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("line is not a JSON object");
      }
      obj = parsed as Record<string, unknown>;
    } catch (err) {
      malformedLines++;
      if (parseErrors.length < 5) {
        parseErrors.push(`line ${i + 1}: ${(err as Error).message}`);
      }
      continue;
    }
    parsedLines++;

    if (obj.type === "assistant" && typeof obj.message === "object" && obj.message) {
      const message = obj.message as Record<string, unknown>;
      const messageId =
        typeof message.id === "string" ? message.id : `__anon_${i}`;

      const usage = readUsage(message.usage as Record<string, unknown> | undefined);
      if (usage) {
        const prev = usageByMessage.get(messageId);
        // Cumulative repeats: the largest observation is the final one.
        if (!prev || usage.total > prev.total) usageByMessage.set(messageId, usage);
      }

      const content = message.content;
      if (Array.isArray(content)) {
        for (const rawBlock of content) {
          if (
            typeof rawBlock !== "object" ||
            rawBlock === null ||
            (rawBlock as Record<string, unknown>).type !== "tool_use"
          ) {
            continue;
          }
          const block = rawBlock as Record<string, unknown>;
          const blockId =
            typeof block.id === "string" ? block.id : `${messageId}#${events.length}`;
          if (seenBlockIds.has(blockId)) continue; // streaming repeat
          seenBlockIds.add(blockId);

          const toolName = typeof block.name === "string" ? block.name : "";
          const input =
            typeof block.input === "object" && block.input !== null
              ? (block.input as Record<string, unknown>)
              : {};
          const hit = classifyToolUse(toolName, input, tool);
          if (hit) {
            events.push({
              kind: hit.kind,
              failed: null,
              statusMasked: hit.statusMasked === true,
              toolName,
              matchedBy: hit.matchedBy,
              blockId,
              messageId: typeof message.id === "string" ? message.id : null,
              detail: hit.detail,
            });
          }
        }
      }
    }

    // Tool results arrive in the following user turn; join them up afterwards.
    if (obj.type === "user" && typeof obj.message === "object" && obj.message) {
      const content = (obj.message as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        for (const rawBlock of content) {
          if (typeof rawBlock !== "object" || rawBlock === null) continue;
          const block = rawBlock as Record<string, unknown>;
          if (block.type !== "tool_result") continue;
          const id = block.tool_use_id;
          if (typeof id !== "string") continue;
          // An absent is_error means success; the field is only set on failure.
          resultErrors.set(id, block.is_error === true);
        }
      }
    }

    if (obj.type === "result") {
      complete = true;
      resultSubtype = typeof obj.subtype === "string" ? obj.subtype : null;
      resultIsError = typeof obj.is_error === "boolean" ? obj.is_error : null;
      reportedTotals = readUsage(obj.usage as Record<string, unknown> | undefined);
      reportedCostUsd =
        typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : null;
    }
  }

  const totals = emptyTotals();
  for (const usage of usageByMessage.values()) {
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheCreation += usage.cacheCreation;
  }
  totals.total =
    totals.input + totals.output + totals.cacheRead + totals.cacheCreation;

  for (const event of events) {
    if (event.statusMasked) {
      // The shell, not the tool, decided this exit code. Unknowable.
      event.failed = null;
      continue;
    }
    const failed = resultErrors.get(event.blockId);
    event.failed = failed === undefined ? null : failed;
  }

  const messageTotals = { ...totals };
  // The result line is complete; the streamed snapshots are not.
  const useResult =
    reportedTotals !== null && reportedTotals.total >= messageTotals.total;
  const best = useResult ? (reportedTotals as TokenTotals) : messageTotals;

  const invocations = events.filter((e) => e.kind === "invocation");
  const invocationCount = invocations.length;
  const invocationFailures = invocations.filter((e) => e.failed === true).length;
  const invocationStatusUnknown = invocations.filter((e) => e.failed === null).length;
  const invocationDeterminate = invocations.length - invocationStatusUnknown;
  const documentationCount = events.filter((e) => e.kind === "documentation").length;

  return {
    file,
    exists: true,
    parseable: parsedLines > 0 && malformedLines === 0,
    complete,
    parseErrors,
    totalLines: meaningful.length,
    parsedLines,
    malformedLines,
    turns: usageByMessage.size,
    totals: best,
    totalsSource: useResult ? "result-line" : "deduped-messages",
    messageTotals,
    resultTotals: reportedTotals,
    reportedCostUsd,
    resultSubtype,
    resultIsError,
    events,
    invocationCount,
    invocationFailures,
    invocationStatusUnknown,
    invocationDeterminate,
    documentationCount,
    invoked: invocationCount > 0,
    readDocs: documentationCount > 0,
  };
}

export function analyzeTranscriptFile(
  file: string,
  tool: ToolUnderTest
): TranscriptAnalysis {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    return {
      file,
      exists: false,
      parseable: false,
      complete: false,
      parseErrors: [`could not read transcript: ${(err as Error).message}`],
      totalLines: 0,
      parsedLines: 0,
      malformedLines: 0,
      turns: 0,
      totals: emptyTotals(),
      totalsSource: "deduped-messages",
      messageTotals: emptyTotals(),
      resultTotals: null,
      reportedCostUsd: null,
      resultSubtype: null,
      resultIsError: null,
      events: [],
      invocationCount: 0,
      invocationFailures: 0,
      invocationStatusUnknown: 0,
      invocationDeterminate: 0,
      documentationCount: 0,
      invoked: false,
      readDocs: false,
    };
  }
  return analyzeTranscriptText(text, tool, file);
}
