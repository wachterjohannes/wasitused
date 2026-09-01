/**
 * Scenario loading with strict validation.
 *
 * Strict on purpose: a silently ignored misspelled field is the class of bug
 * that turns a whole batch into meaningless rows without anything looking wrong.
 * Unknown keys are errors, not warnings.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedScenario, ScenarioConfig } from "./types";

export class ScenarioValidationError extends Error {
  constructor(
    public readonly configPath: string,
    public readonly problems: string[]
  ) {
    super(
      `Invalid scenario ${configPath}:\n` +
        problems.map((p) => `  - ${p}`).join("\n")
    );
    this.name = "ScenarioValidationError";
  }
}

const SCENARIO_KEYS = [
  "id",
  "description",
  "toolRelevant",
  "prompt",
  "fixture",
  "check",
  "agent",
  "tool",
];
const CHECK_KEYS = ["command", "timeoutMs"];
const AGENT_KEYS = ["model", "maxTurns", "timeoutMs"];
const TOOL_KEYS = ["name", "enable", "invocation", "documentation"];
const ENABLE_KEYS = [
  "skills",
  "mcpServers",
  "env",
  "fixtureFiles",
  "appendSystemPrompt",
];
const INVOCATION_KEYS = ["toolNames", "bashPatterns", "skillNames"];
const DOCUMENTATION_KEYS = ["pathPatterns", "skillNames"];

export const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_MAX_TURNS = 40;
const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CHECK_TIMEOUT_MS = 60 * 1000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function unknownKeys(
  obj: Record<string, unknown>,
  allowed: string[],
  where: string,
  problems: string[]
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      problems.push(
        `${where}: unknown field "${key}" (allowed: ${allowed.join(", ")})`
      );
    }
  }
}

function stringArray(
  value: unknown,
  where: string,
  problems: string[]
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    problems.push(`${where}: must be an array of strings`);
    return undefined;
  }
  return value as string[];
}

/** Validates and normalises a parsed scenario object. Throws on any problem. */
export function validateScenario(
  raw: unknown,
  configPath: string
): ScenarioConfig {
  const problems: string[] = [];

  if (!isPlainObject(raw)) {
    throw new ScenarioValidationError(configPath, ["top level must be an object"]);
  }
  unknownKeys(raw, SCENARIO_KEYS, "scenario", problems);

  if (typeof raw.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(raw.id)) {
    problems.push('id: required, lowercase kebab-case (e.g. "greeting-locale")');
  }
  if (raw.description !== undefined && typeof raw.description !== "string") {
    problems.push("description: must be a string");
  }
  if (typeof raw.toolRelevant !== "boolean") {
    problems.push(
      "toolRelevant: required boolean — say explicitly whether the tool can help here"
    );
  }
  if (typeof raw.prompt !== "string" || raw.prompt.trim() === "") {
    problems.push("prompt: required non-empty string");
  }
  if (typeof raw.fixture !== "string" || raw.fixture.trim() === "") {
    problems.push("fixture: required path to the fixture directory");
  }

  // check
  let check = { command: "", timeoutMs: DEFAULT_CHECK_TIMEOUT_MS };
  if (!isPlainObject(raw.check)) {
    problems.push("check: required object with a `command`");
  } else {
    unknownKeys(raw.check, CHECK_KEYS, "check", problems);
    if (typeof raw.check.command !== "string" || raw.check.command.trim() === "") {
      problems.push("check.command: required non-empty string");
    }
    if (raw.check.timeoutMs !== undefined && typeof raw.check.timeoutMs !== "number") {
      problems.push("check.timeoutMs: must be a number");
    }
    check = {
      command: String(raw.check.command ?? ""),
      timeoutMs: Number(raw.check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS),
    };
  }

  // agent
  let agent = {
    model: DEFAULT_MODEL,
    maxTurns: DEFAULT_MAX_TURNS,
    timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
  };
  if (raw.agent !== undefined) {
    if (!isPlainObject(raw.agent)) {
      problems.push("agent: must be an object");
    } else {
      unknownKeys(raw.agent, AGENT_KEYS, "agent", problems);
      if (raw.agent.model !== undefined && typeof raw.agent.model !== "string") {
        problems.push("agent.model: must be a string");
      }
      if (raw.agent.maxTurns !== undefined && typeof raw.agent.maxTurns !== "number") {
        problems.push("agent.maxTurns: must be a number");
      }
      if (raw.agent.timeoutMs !== undefined && typeof raw.agent.timeoutMs !== "number") {
        problems.push("agent.timeoutMs: must be a number");
      }
      agent = {
        model: String(raw.agent.model ?? DEFAULT_MODEL),
        maxTurns: Number(raw.agent.maxTurns ?? DEFAULT_MAX_TURNS),
        timeoutMs: Number(raw.agent.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS),
      };
    }
  }

  // tool
  let tool: ScenarioConfig["tool"] = {
    name: "",
    enable: {},
    invocation: {},
  };
  if (!isPlainObject(raw.tool)) {
    problems.push("tool: required object describing the tool under test");
  } else {
    unknownKeys(raw.tool, TOOL_KEYS, "tool", problems);
    if (typeof raw.tool.name !== "string" || raw.tool.name.trim() === "") {
      problems.push("tool.name: required non-empty string");
    }

    const enable: ScenarioConfig["tool"]["enable"] = {};
    if (!isPlainObject(raw.tool.enable)) {
      problems.push(
        "tool.enable: required object — how the tool is switched on for the with_tool condition"
      );
    } else {
      unknownKeys(raw.tool.enable, ENABLE_KEYS, "tool.enable", problems);
      const skills = stringArray(raw.tool.enable.skills, "tool.enable.skills", problems);
      if (skills) enable.skills = skills;
      const fixtureFiles = stringArray(
        raw.tool.enable.fixtureFiles,
        "tool.enable.fixtureFiles",
        problems
      );
      if (fixtureFiles) enable.fixtureFiles = fixtureFiles;
      if (raw.tool.enable.mcpServers !== undefined) {
        if (!isPlainObject(raw.tool.enable.mcpServers)) {
          problems.push("tool.enable.mcpServers: must be an object");
        } else {
          enable.mcpServers = raw.tool.enable.mcpServers;
        }
      }
      if (raw.tool.enable.env !== undefined) {
        if (
          !isPlainObject(raw.tool.enable.env) ||
          Object.values(raw.tool.enable.env).some((v) => typeof v !== "string")
        ) {
          problems.push("tool.enable.env: must be an object of string values");
        } else {
          enable.env = raw.tool.enable.env as Record<string, string>;
        }
      }
      if (raw.tool.enable.appendSystemPrompt !== undefined) {
        if (typeof raw.tool.enable.appendSystemPrompt !== "string") {
          problems.push("tool.enable.appendSystemPrompt: must be a string");
        } else {
          enable.appendSystemPrompt = raw.tool.enable.appendSystemPrompt;
        }
      }
      if (Object.keys(enable).length === 0) {
        problems.push(
          "tool.enable: empty — the with_tool condition would be identical to baseline"
        );
      }
    }

    const invocation: ScenarioConfig["tool"]["invocation"] = {};
    if (!isPlainObject(raw.tool.invocation)) {
      problems.push(
        "tool.invocation: required object — how an actual tool call is recognised in the transcript"
      );
    } else {
      unknownKeys(raw.tool.invocation, INVOCATION_KEYS, "tool.invocation", problems);
      const toolNames = stringArray(
        raw.tool.invocation.toolNames,
        "tool.invocation.toolNames",
        problems
      );
      if (toolNames) invocation.toolNames = toolNames;
      const bashPatterns = stringArray(
        raw.tool.invocation.bashPatterns,
        "tool.invocation.bashPatterns",
        problems
      );
      if (bashPatterns) invocation.bashPatterns = bashPatterns;
      const skillNames = stringArray(
        raw.tool.invocation.skillNames,
        "tool.invocation.skillNames",
        problems
      );
      if (skillNames) invocation.skillNames = skillNames;
      for (const pattern of bashPatterns ?? []) {
        try {
          new RegExp(pattern);
        } catch (err) {
          problems.push(
            `tool.invocation.bashPatterns: "${pattern}" is not a valid regex (${
              (err as Error).message
            })`
          );
        }
      }
      if (Object.keys(invocation).length === 0) {
        problems.push(
          "tool.invocation: empty — adoption could never be detected, every run would read as 'not invoked'"
        );
      }
    }

    const documentation: ScenarioConfig["tool"]["documentation"] = {};
    if (raw.tool.documentation !== undefined) {
      if (!isPlainObject(raw.tool.documentation)) {
        problems.push("tool.documentation: must be an object");
      } else {
        unknownKeys(
          raw.tool.documentation,
          DOCUMENTATION_KEYS,
          "tool.documentation",
          problems
        );
        const pathPatterns = stringArray(
          raw.tool.documentation.pathPatterns,
          "tool.documentation.pathPatterns",
          problems
        );
        if (pathPatterns) documentation.pathPatterns = pathPatterns;
        const docSkillNames = stringArray(
          raw.tool.documentation.skillNames,
          "tool.documentation.skillNames",
          problems
        );
        if (docSkillNames) documentation.skillNames = docSkillNames;
        for (const name of docSkillNames ?? []) {
          if ((raw.tool.invocation as Record<string, unknown> | undefined)?.skillNames &&
              (raw.tool.invocation as { skillNames?: string[] }).skillNames?.includes(name)) {
            problems.push(
              `tool.documentation.skillNames: "${name}" is also in tool.invocation.skillNames — ` +
                "a skill is either the tool or the documentation for it, not both"
            );
          }
        }
        for (const pattern of pathPatterns ?? []) {
          try {
            new RegExp(pattern);
          } catch (err) {
            problems.push(
              `tool.documentation.pathPatterns: "${pattern}" is not a valid regex (${
                (err as Error).message
              })`
            );
          }
        }
      }
    }

    tool = {
      name: String(raw.tool.name ?? ""),
      enable,
      invocation,
      ...(Object.keys(documentation).length > 0 ? { documentation } : {}),
    };
  }

  if (problems.length > 0) {
    throw new ScenarioValidationError(configPath, problems);
  }

  return {
    id: raw.id as string,
    ...(raw.description !== undefined
      ? { description: raw.description as string }
      : {}),
    toolRelevant: raw.toolRelevant as boolean,
    prompt: raw.prompt as string,
    fixture: raw.fixture as string,
    check,
    agent,
    tool,
  };
}

export function loadScenario(configPath: string): ResolvedScenario {
  const abs = path.resolve(configPath);
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    throw new ScenarioValidationError(abs, ["file could not be read"]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ScenarioValidationError(abs, [
      `not valid JSON: ${(err as Error).message}`,
    ]);
  }
  const config = validateScenario(parsed, abs);
  const dir = path.dirname(abs);
  const fixturePath = path.resolve(dir, config.fixture);
  if (!fs.existsSync(fixturePath) || !fs.statSync(fixturePath).isDirectory()) {
    throw new ScenarioValidationError(abs, [
      `fixture: "${config.fixture}" does not resolve to a directory (${fixturePath})`,
    ]);
  }
  for (const skill of config.tool.enable.skills ?? []) {
    const p = path.resolve(dir, skill);
    if (!fs.existsSync(p)) {
      throw new ScenarioValidationError(abs, [
        `tool.enable.skills: "${skill}" does not exist (${p})`,
      ]);
    }
  }
  for (const file of config.tool.enable.fixtureFiles ?? []) {
    const p = path.resolve(dir, file);
    if (!fs.existsSync(p)) {
      throw new ScenarioValidationError(abs, [
        `tool.enable.fixtureFiles: "${file}" does not exist (${p})`,
      ]);
    }
  }
  return { ...config, configPath: abs, dir, fixturePath };
}
