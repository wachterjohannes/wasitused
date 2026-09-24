/**
 * Failure modes specific to opencode as the agent under test.
 *
 * Each test deliberately produces a way the adapter could return a confident,
 * wrong number and asserts it does not:
 *
 * - counting only the top-level session, so work a subagent did costs nothing;
 * - treating a bash call that exited non-zero as a success because opencode
 *   itself marks it "completed";
 * - leaking the operator's own skills through $HOME, which an empty
 *   XDG_CONFIG_HOME alone does not stop;
 * - a missing provider credential producing a batch of zero-cost "failures";
 * - a run that recorded nothing being given a result line, which would hide it
 *   from the dud guard.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { test, describe, after } from "node:test";
import {
  buildOpencodeArgv,
  buildOpencodeConfig,
  normalizeOpencodeExport,
  stripOpencodeEnv,
  type OpencodeExport,
} from "../src/opencode";
import { DudGuardError, IsolationBreachError, runBatch, type SpawnAgentFn } from "../src/runner";
import { loadScenario, ScenarioValidationError } from "../src/scenario";
import { analyzeTranscriptText } from "../src/transcript";
import type { RunRecord, ToolUnderTest } from "../src/types";
import { makeScenarioDir, tmpDir } from "./helpers";

const created: string[] = [];
function scratch(name: string): string {
  const dir = tmpDir(name);
  created.push(dir);
  return dir;
}
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

const TOOL: ToolUnderTest = {
  name: "phrasebook",
  enable: { fixtureFiles: ["../phrasebook-tool/tools"] },
  invocation: { bashPatterns: ["tools[/\\\\]phrasebook"] },
  documentation: {
    pathPatterns: ["phrasebook[/\\\\]SKILL\\.md"],
    skillNames: ["phrasebook"],
  },
};

function msg(id: string, session: string, tokens: Record<string, unknown>, cost = 0.001, extra = {}) {
  return {
    id,
    session_id: session,
    time_created: 1,
    data: JSON.stringify({ role: "assistant", modelID: "some-model", tokens, cost, ...extra }),
  };
}
function toolPart(messageId: string, session: string, callID: string, tool: string, state: Record<string, unknown>) {
  return {
    id: `prt_${callID}`,
    message_id: messageId,
    session_id: session,
    time_created: 1,
    data: JSON.stringify({ type: "tool", tool, callID, state }),
  };
}

/** A parent session that delegates to a subagent, as opencode's `task` tool does. */
function exportWithSubagent(): OpencodeExport {
  const tk = (input: number, output: number, read = 0) => ({
    input,
    output,
    reasoning: 5,
    cache: { read, write: 0 },
  });
  return {
    sessions: [
      { id: "ses_parent", parent_id: null, title: "t", time_created: 1 },
      { id: "ses_child", parent_id: "ses_parent", title: "sub", time_created: 2 },
    ],
    messages: [
      { id: "msg_u", session_id: "ses_parent", time_created: 0, data: JSON.stringify({ role: "user" }) },
      msg("msg_p1", "ses_parent", tk(1000, 50)),
      msg("msg_c1", "ses_child", tk(2000, 40, 100)),
      msg("msg_p2", "ses_parent", tk(300, 20, 900)),
    ],
    parts: [
      toolPart("msg_p1", "ses_parent", "call_task", "task", {
        status: "completed",
        input: { prompt: "look it up", subagent_type: "general" },
        output: "done",
      }),
      toolPart("msg_c1", "ses_child", "call_skill", "skill", {
        status: "completed",
        input: { name: "phrasebook" },
        output: "skill body",
      }),
      toolPart("msg_c1", "ses_child", "call_bash_ok", "bash", {
        status: "completed",
        input: { command: "tools/phrasebook greeting fr" },
        output: "Bonjour !",
        metadata: { exit: 0 },
      }),
      toolPart("msg_p2", "ses_parent", "call_bash_fail", "bash", {
        status: "completed",
        input: { command: "tools/phrasebook nope" },
        output: "unknown phrase",
        metadata: { exit: 2 },
      }),
      toolPart("msg_p2", "ses_parent", "call_bash_silent", "bash", {
        status: "completed",
        input: { command: "true" },
        output: "",
        metadata: { exit: 0 },
      }),
      toolPart("msg_p2", "ses_parent", "call_read", "read", {
        status: "completed",
        input: { filePath: "/work/phrasebook/SKILL.md" },
        output: "docs",
      }),
      toolPart("msg_p2", "ses_parent", "call_running", "bash", {
        status: "running",
        input: { command: "tools/phrasebook still-going" },
      }),
    ],
    error: null,
  };
}

describe("opencode transcript normalization", () => {
  const text = normalizeOpencodeExport(exportWithSubagent());
  const a = analyzeTranscriptText(text, TOOL);

  test("usage is summed over every session, subagents included", () => {
    // input 1000+2000+300, output (50+5)+(40+5)+(20+5), cache read 100+900
    assert.equal(a.totals.input, 3300);
    assert.equal(a.totals.output, 125);
    assert.equal(a.totals.cacheRead, 1000);
    assert.equal(a.totals.total, 3300 + 125 + 1000);
    assert.equal(a.totalsSource, "result-line");
    assert.ok(Math.abs((a.reportedCostUsd ?? 0) - 0.003) < 1e-9);
  });

  test("each assistant message is one turn, the subagent's included", () => {
    assert.equal(a.turns, 3);
  });

  test("a bash call that exited non-zero is a failed call, not a success", () => {
    const failed = a.events.find((e) => e.blockId === "call_bash_fail");
    assert.ok(failed);
    assert.equal(failed.kind, "invocation");
    assert.equal(failed.failed, true);
    const ok = a.events.find((e) => e.blockId === "call_bash_ok");
    assert.equal(ok?.failed, false);
    assert.equal(a.invocationCount, 2, "the still-running call has no outcome and is not counted");
    assert.equal(a.invocationFailures, 1);
  });

  test("skills and file reads map onto the documentation matchers", () => {
    const docs = a.events.filter((e) => e.kind === "documentation").map((e) => e.matchedBy);
    assert.ok(docs.includes("documentation.skillNames:phrasebook"));
    assert.ok(docs.some((d) => d.startsWith("pathPatterns:")));
  });

  test("an output-free shell result counts toward shell health", () => {
    assert.equal(a.shellCalls, 3);
    assert.equal(a.shellSilentFailures, 1);
  });

  test("the original opencode tool name is kept next to the mapped one", () => {
    assert.match(text, /"name":"Bash","opencode_tool":"bash"/);
    assert.match(text, /"name":"Task","opencode_tool":"task"/);
  });

  test("an export that failed produces no result line, so the run stays zero-cost", () => {
    const failed = normalizeOpencodeExport({ ...exportWithSubagent(), error: "db locked" });
    assert.doesNotMatch(failed, /"type":"result"/);
  });

  test("a run that recorded no assistant message produces an empty transcript", () => {
    const empty = normalizeOpencodeExport({ sessions: [], messages: [], parts: [], error: null });
    assert.equal(empty, "");
    assert.equal(analyzeTranscriptText(empty, TOOL).totals.total, 0);
  });

  test("a provider error is surfaced on the result line", () => {
    const exp = exportWithSubagent();
    exp.messages.push(
      msg("msg_err", "ses_parent", { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, 0, {
        error: { name: "APIError", data: { message: "not included in your plan" } },
      })
    );
    const out = normalizeOpencodeExport(exp);
    const result = JSON.parse(out.trim().split("\n").pop() as string) as Record<string, unknown>;
    assert.equal(result.is_error, true);
    assert.match(String(result.error), /not included/);
  });
});

describe("opencode config and argv", () => {
  test("the turn cap, the pinned model and the off-switches are written", () => {
    const c = buildOpencodeConfig({
      model: "prov/model-x",
      maxTurns: 17,
      skillPaths: [],
      instructionFiles: [],
      mcpServers: null,
    });
    assert.deepEqual(c.agent, { build: { steps: 17 } });
    assert.equal(c.model, "prov/model-x");
    assert.equal(c.small_model, "prov/model-x", "title generation must not reach a second model");
    for (const key of ["lsp", "formatter", "snapshot", "autoupdate"]) assert.equal(c[key], false, key);
    assert.equal(c.share, "disabled");
    assert.equal(c.skills, undefined);
  });

  test("Claude-Code-shaped MCP servers are translated, not dropped", () => {
    const c = buildOpencodeConfig({
      model: "m",
      maxTurns: 5,
      skillPaths: ["/tmp/x/skills"],
      instructionFiles: ["/tmp/x/append.md"],
      mcpServers: { book: { command: "node", args: ["/abs/server.js"], env: { A: "1" } } },
    });
    assert.deepEqual(c.mcp, {
      book: { type: "local", command: ["node", "/abs/server.js"], enabled: true, environment: { A: "1" } },
    });
    assert.deepEqual(c.skills, { paths: ["/tmp/x/skills"] });
    assert.deepEqual(c.instructions, ["/tmp/x/append.md"]);
  });

  test("OPENCODE_* variables from the host are stripped", () => {
    const { env, stripped } = stripOpencodeEnv({
      PATH: "/bin",
      OPENCODE_CONFIG: "/home/op/.config/opencode/opencode.json",
      OPENCODE_SERVER_PASSWORD: "x",
    });
    assert.deepEqual(stripped, ["OPENCODE_CONFIG", "OPENCODE_SERVER_PASSWORD"]);
    assert.deepEqual(Object.keys(env), ["PATH"]);
  });
});

describe("opencode runs through the batch loop", () => {
  function fakeOpencode(seen: { env?: NodeJS.ProcessEnv; argv?: string[] }): SpawnAgentFn {
    return async (req) => {
      seen.env = req.env;
      seen.argv = req.argv;
      fs.writeFileSync(req.transcriptFile, '{"type":"step_start"}\n');
      fs.writeFileSync(req.stderrFile, "");
      return { exitCode: 0, signal: null, timedOut: false };
    };
  }

  test("HOME and all XDG dirs are per-run temp dirs, and the credential never reaches disk or argv", async () => {
    const root = scratch("oc-isolation");
    const scenario = makeScenarioDir(root);
    const seen: { env?: NodeJS.ProcessEnv; argv?: string[] } = {};
    process.env.WASITUSED_TEST_PROVIDER_KEY = "sk-secret-provider-value";
    process.env.OPENCODE_CONFIG = "/home/operator/.config/opencode/opencode.json";
    try {
      const { batchDir } = await runBatch(scenario, {
        n: 1,
        conditions: ["with_tool"],
        outDir: path.join(root, "runs"),
        credential: { kind: "file", path: path.join(root, "none.json") },
        tmpRoot: root,
        agentKind: "opencode",
        providerEnv: ["WASITUSED_TEST_PROVIDER_KEY"],
        keepTemp: true,
        spawnAgent: fakeOpencode(seen),
        exportSessions: () => exportWithSubagent(),
        log: () => {},
      });
      const env = seen.env as NodeJS.ProcessEnv;
      const record = JSON.parse(
        fs.readFileSync(path.join(batchDir, "runs", "with_tool-001", "run.json"), "utf8")
      ) as RunRecord;
      for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
        assert.ok(String(env[key]).startsWith(record.tempDir), `${key} must live in the run's temp dir`);
      }
      assert.equal(env.OPENCODE_CONFIG, undefined);
      assert.ok(record.envKeysStripped.includes("OPENCODE_CONFIG"));
      assert.equal(record.agentKind, "opencode");
      assert.equal(record.credential.source, "provider-env");

      const config = JSON.parse(
        fs.readFileSync(path.join(String(env.XDG_CONFIG_HOME), "opencode", "opencode.json"), "utf8")
      ) as Record<string, unknown>;
      assert.equal((config.agent as { build: { steps: number } }).build.steps, scenario.agent.maxTurns);

      // The secret is inherited by the child through its env only.
      const everything = [
        JSON.stringify(seen.argv),
        fs.readFileSync(path.join(batchDir, "runs", "with_tool-001", "run.json"), "utf8"),
        fs.readFileSync(path.join(batchDir, "batch.json"), "utf8"),
        fs.readFileSync(path.join(String(env.XDG_CONFIG_HOME), "opencode", "opencode.json"), "utf8"),
      ].join("\n");
      assert.doesNotMatch(everything, /sk-secret-provider-value/);

      // The metrics transcript is the normalized session export; the raw files sit beside it.
      const runDir = path.join(batchDir, "runs", "with_tool-001");
      assert.ok(fs.existsSync(path.join(runDir, "opencode.events.jsonl")));
      assert.ok(fs.existsSync(path.join(runDir, "opencode.sessions.json")));
      const a = analyzeTranscriptText(fs.readFileSync(path.join(runDir, "transcript.jsonl"), "utf8"), TOOL);
      assert.equal(a.turns, 3);
      assert.equal(a.invoked, true);
    } finally {
      delete process.env.WASITUSED_TEST_PROVIDER_KEY;
      delete process.env.OPENCODE_CONFIG;
    }
  });

  test("a batch refuses to start while a named provider credential is missing", async () => {
    const root = scratch("oc-missing-key");
    const scenario = makeScenarioDir(root);
    delete process.env.WASITUSED_TEST_ABSENT_KEY;
    let spawned = 0;
    const err = await runBatch(scenario, {
      n: 2,
      outDir: path.join(root, "runs"),
      credential: { kind: "file", path: path.join(root, "none.json") },
      tmpRoot: root,
      agentKind: "opencode",
      providerEnv: ["WASITUSED_TEST_ABSENT_KEY"],
      spawnAgent: async () => {
        spawned++;
        return { exitCode: 0, signal: null, timedOut: false };
      },
      exportSessions: () => exportWithSubagent(),
      log: () => {},
    }).then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(err instanceof Error);
    assert.match((err as Error).message, /WASITUSED_TEST_ABSENT_KEY/);
    assert.equal(spawned, 0, "nothing may be spent");
  });

  test("runs that recorded nothing trip the dud guard", async () => {
    const root = scratch("oc-dud");
    const scenario = makeScenarioDir(root);
    const err = await runBatch(scenario, {
      n: 5,
      outDir: path.join(root, "runs"),
      credential: { kind: "file", path: path.join(root, "none.json") },
      tmpRoot: root,
      agentKind: "opencode",
      spawnAgent: fakeOpencode({}),
      // What a refused model leaves behind: the session exists, no assistant work.
      exportSessions: () => ({
        sessions: [{ id: "ses_x", parent_id: null }],
        messages: [{ id: "m", session_id: "ses_x", data: JSON.stringify({ role: "user" }) }],
        parts: [],
        error: null,
      }),
      log: () => {},
    }).then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(err instanceof DudGuardError);
  });

  test("the argv carries the prompt and pinned model, and no credential", () => {
    const root = scratch("oc-argv");
    const scenario = makeScenarioDir(root);
    const argv = buildOpencodeArgv(scenario, "prov/m");
    assert.deepEqual(argv.slice(0, 6), ["opencode", "run", "--model", "prov/m", "--format", "json"]);
    assert.equal(argv[argv.length - 1], scenario.prompt);
  });
});

describe("scenario validation", () => {
  test("an unknown agent.kind is rejected rather than defaulted", () => {
    const root = scratch("oc-kind");
    const scenario = makeScenarioDir(root);
    const raw = JSON.parse(fs.readFileSync(scenario.configPath, "utf8")) as Record<string, unknown>;
    raw.agent = { ...(raw.agent as object), kind: "open-code" };
    fs.writeFileSync(scenario.configPath, JSON.stringify(raw));
    assert.throws(() => loadScenario(scenario.configPath), ScenarioValidationError);
  });
});

describe("the working directory the agent sees", () => {
  test("PWD is the run's working copy for both agents, not the harness's cwd", async () => {
    for (const agentKind of ["claude-code", "opencode"] as const) {
      const root = scratch(`pwd-${agentKind}`);
      const scenario = makeScenarioDir(root);
      let seen: { cwd?: string; env?: NodeJS.ProcessEnv } = {};
      process.env.WASITUSED_TEST_PROVIDER_KEY = "x";
      try {
        await runBatch(scenario, {
          n: 1,
          conditions: ["with_tool"],
          outDir: path.join(root, "runs"),
          credential: { kind: "file", path: path.join(root, "none.json") },
          tmpRoot: root,
          agentKind,
          providerEnv: agentKind === "opencode" ? ["WASITUSED_TEST_PROVIDER_KEY"] : [],
          spawnAgent: async (req) => {
            seen = { cwd: req.cwd, env: req.env };
            fs.writeFileSync(req.transcriptFile, "");
            fs.writeFileSync(req.stderrFile, "");
            return { exitCode: 0, signal: null, timedOut: false };
          },
          exportSessions: () => exportWithSubagent(),
          log: () => {},
        });
      } finally {
        delete process.env.WASITUSED_TEST_PROVIDER_KEY;
      }
      assert.equal(seen.env?.PWD, seen.cwd, `${agentKind}: PWD must follow cwd`);
      assert.notEqual(seen.env?.PWD, process.cwd(), `${agentKind}: PWD must not be the harness's`);
    }
  });

  test("an agent that writes into the source fixture aborts the batch as an isolation breach", async () => {
    const root = scratch("breach");
    const scenario = makeScenarioDir(root);
    let runs = 0;
    const err = await runBatch(scenario, {
      n: 3,
      outDir: path.join(root, "runs"),
      credential: { kind: "file", path: path.join(root, "none.json") },
      tmpRoot: root,
      agentKind: "opencode",
      spawnAgent: async (req) => {
        runs++;
        // What happened for real: the agent resolved its project from the
        // harness's PWD and wrote the answer into the original fixture.
        fs.writeFileSync(path.join(scenario.fixturePath, "answer.txt"), "leaked\n");
        fs.writeFileSync(req.transcriptFile, "");
        fs.writeFileSync(req.stderrFile, "");
        return { exitCode: 0, signal: null, timedOut: false };
      },
      exportSessions: () => exportWithSubagent(),
      log: () => {},
    }).then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(err instanceof IsolationBreachError, "the batch must not continue");
    assert.equal(runs, 1, "it stops after the first breaching run");
    assert.deepEqual(err.changed, ["added fixture/answer.txt"]);
    const batchDir = fs.readdirSync(path.join(root, "runs"))[0] as string;
    const batch = JSON.parse(fs.readFileSync(path.join(root, "runs", batchDir, "batch.json"), "utf8")) as {
      aborted: boolean;
      abortReason: string;
    };
    assert.equal(batch.aborted, true);
    assert.match(batch.abortReason, /isolation breach/i);
  });
});

describe("agent configuration in ancestor directories", () => {
  test("a temp root below a directory with agent config is refused before anything is spent", async () => {
    for (const marker of [".claude", "AGENTS.md", "CLAUDE.md"]) {
      const root = scratch("ancestor");
      const outer = path.join(root, "home-like");
      const inner = path.join(outer, "tmp");
      fs.mkdirSync(inner, { recursive: true });
      // What was measured: opencode listed skills from a .claude/skills two levels up.
      if (marker === ".claude") fs.mkdirSync(path.join(outer, ".claude", "skills"), { recursive: true });
      else fs.writeFileSync(path.join(outer, marker), "operator instructions\n");
      const scenario = makeScenarioDir(root);
      let spawned = 0;
      for (const agentKind of ["claude-code", "opencode"] as const) {
        const err = await runBatch(scenario, {
          n: 1,
          outDir: path.join(root, "runs"),
          credential: { kind: "file", path: path.join(root, "none.json") },
          tmpRoot: inner,
          agentKind,
          spawnAgent: async () => {
            spawned++;
            return { exitCode: 0, signal: null, timedOut: false };
          },
          exportSessions: () => exportWithSubagent(),
          log: () => {},
        }).then(
          () => null,
          (e: unknown) => e
        );
        assert.ok(err instanceof Error, `${agentKind} / ${marker}`);
        assert.match((err as Error).message, /ancestor/i);
      }
      assert.equal(spawned, 0);
    }
  });
});
