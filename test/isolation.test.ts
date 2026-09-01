/**
 * Failure mode: measuring the developer's own machine.
 *
 * If the spawned agent inherits the host's config dir, env or working tree,
 * every scenario silently runs with whatever skills, CLAUDE.md and memory the
 * harness operator happens to have. The baseline stops being a baseline and
 * nothing in the output looks wrong.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, describe, after } from "node:test";
import {
  humanDuration,
  inspectCredentials,
  prepareIsolatedRun,
  stripInheritedAgentEnv,
} from "../src/isolation";
import { buildAgentArgv, runBatch, type SpawnAgentFn } from "../src/runner";
import {
  assistantLine,
  initLine,
  makeScenarioDir,
  resultLine,
  tmpDir,
  transcript,
} from "./helpers";

const created: string[] = [];
function scratch(name: string): string {
  const dir = tmpDir(name);
  created.push(dir);
  return dir;
}
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

describe("environment isolation", () => {
  test("every inherited CLAUDE_* variable is stripped", () => {
    const { env, stripped } = stripInheritedAgentEnv({
      PATH: "/usr/bin",
      HOME: "/home/someone",
      CLAUDE_CONFIG_DIR: "/home/someone/.claude",
      CLAUDE_CODE_SESSION_ID: "leaked",
      CLAUDECODE: "1",
      LANG: "en_US.UTF-8",
    });

    assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.PATH, "/usr/bin", "unrelated variables are kept");
    assert.equal(env.LANG, "en_US.UTF-8");
    assert.deepEqual(stripped, [
      "CLAUDECODE",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CONFIG_DIR",
    ]);
  });

  test("the run record lists what was stripped, so contamination is auditable", async () => {
    const root = scratch("stripped");
    const scenario = makeScenarioDir(root);
    const agent: SpawnAgentFn = async (req) => {
      fs.writeFileSync(
        req.transcriptFile,
        transcript([initLine(), assistantLine("m1", { output_tokens: 9 }), resultLine()])
      );
      fs.writeFileSync(req.stderrFile, "");
      // The child must be pointed at the throwaway config, never the real one.
      assert.ok(req.env.CLAUDE_CONFIG_DIR?.startsWith(root));
      assert.notEqual(
        req.env.CLAUDE_CONFIG_DIR,
        path.join(os.homedir(), ".claude")
      );
      return { exitCode: 0, signal: null, timedOut: false };
    };

    const { batchDir, batch } = await runBatch(scenario, {
      n: 1,
      outDir: path.join(root, "runs"),
      credentialsPath: path.join(root, "credentials.json"),
      tmpRoot: root,
      spawnAgent: agent,
      log: () => {},
    });

    const record = JSON.parse(
      fs.readFileSync(
        path.join(batchDir, batch.runDirs[0] as string, "run.json"),
        "utf8"
      )
    ) as { envKeysStripped: string[] };
    assert.ok(Array.isArray(record.envKeysStripped));
  });
});

describe("filesystem isolation", () => {
  test("the agent gets a fresh copy of the fixture, not the fixture itself", () => {
    const root = scratch("fixture");
    const scenario = makeScenarioDir(root);

    const run = prepareIsolatedRun({
      scenarioId: "example",
      condition: "with_tool",
      index: 1,
      fixturePath: scenario.fixturePath,
      scenarioDir: scenario.dir,
      toolEnabled: false,
      credentialsPath: path.join(root, "nope.json"),
      tmpRoot: root,
    });

    assert.notEqual(path.resolve(run.workDir), path.resolve(scenario.fixturePath));
    assert.equal(fs.readFileSync(path.join(run.workDir, "app.txt"), "utf8"), "original\n");

    // The agent trashing its workspace must not touch the scenario source.
    fs.writeFileSync(path.join(run.workDir, "app.txt"), "agent scribbled here\n");
    assert.equal(
      fs.readFileSync(path.join(scenario.fixturePath, "app.txt"), "utf8"),
      "original\n"
    );
    run.cleanup();
    assert.equal(fs.existsSync(run.tempDir), false);
  });

  test("the config dir starts bare — no host skills, no host CLAUDE.md", () => {
    const root = scratch("bare");
    const scenario = makeScenarioDir(root);
    const run = prepareIsolatedRun({
      scenarioId: "example",
      condition: "baseline",
      index: 1,
      fixturePath: scenario.fixturePath,
      scenarioDir: scenario.dir,
      toolEnabled: false,
      credentialsPath: path.join(root, "nope.json"),
      tmpRoot: root,
    });

    assert.deepEqual(fs.readdirSync(run.configDir), ["settings.json"]);
    assert.equal(fs.existsSync(path.join(run.configDir, "CLAUDE.md")), false);
    assert.equal(fs.existsSync(path.join(run.configDir, "skills")), false);
  });

  test("the tool is present in with_tool and absent in baseline", () => {
    const root = scratch("toggle");
    const scenario = makeScenarioDir(root);
    // A skill dir and an overlay dir belonging to the tool under test.
    fs.mkdirSync(path.join(scenario.dir, "tool", "skills", "phrasebook"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(scenario.dir, "tool", "skills", "phrasebook", "SKILL.md"),
      "# phrasebook\n"
    );
    fs.mkdirSync(path.join(scenario.dir, "tool", "tools"), { recursive: true });
    fs.writeFileSync(path.join(scenario.dir, "tool", "tools", "phrasebook"), "#!/bin/sh\n");

    const common = {
      scenarioId: "example",
      index: 1,
      fixturePath: scenario.fixturePath,
      scenarioDir: scenario.dir,
      skills: ["tool/skills/phrasebook"],
      fixtureFiles: ["tool/tools"],
      credentialsPath: path.join(root, "nope.json"),
      tmpRoot: root,
    };

    const withTool = prepareIsolatedRun({
      ...common,
      condition: "with_tool",
      toolEnabled: true,
    });
    assert.ok(
      fs.existsSync(path.join(withTool.configDir, "skills", "phrasebook", "SKILL.md"))
    );
    assert.ok(fs.existsSync(path.join(withTool.workDir, "tools", "phrasebook")));

    const baseline = prepareIsolatedRun({
      ...common,
      condition: "baseline",
      toolEnabled: false,
    });
    assert.equal(fs.existsSync(path.join(baseline.configDir, "skills")), false);
    assert.equal(fs.existsSync(path.join(baseline.workDir, "tools")), false);

    withTool.cleanup();
    baseline.cleanup();
  });

  test("mcp servers are wired only for the with_tool condition", () => {
    const root = scratch("mcp");
    const scenario = makeScenarioDir(root);
    const common = {
      scenarioId: "example",
      index: 1,
      fixturePath: scenario.fixturePath,
      scenarioDir: scenario.dir,
      mcpServers: { phrasebook: { command: "node", args: ["./server.js"] } },
      credentialsPath: path.join(root, "nope.json"),
      tmpRoot: root,
    };

    const withTool = prepareIsolatedRun({
      ...common,
      condition: "with_tool",
      toolEnabled: true,
    });
    assert.ok(withTool.mcpConfigPath);
    const cfg = JSON.parse(fs.readFileSync(withTool.mcpConfigPath, "utf8")) as {
      mcpServers: { phrasebook: { args: string[] } };
    };
    assert.equal(
      cfg.mcpServers.phrasebook.args[0],
      path.join(scenario.dir, "server.js"),
      "relative server paths must be resolved against the scenario, not the agent's cwd"
    );

    const baseline = prepareIsolatedRun({
      ...common,
      condition: "baseline",
      toolEnabled: false,
    });
    assert.equal(baseline.mcpConfigPath, null);

    const argvWith = buildAgentArgv(scenario, "claude-opus-5", true, withTool.mcpConfigPath);
    assert.ok(argvWith.includes("--strict-mcp-config"));
    const argvBase = buildAgentArgv(scenario, "claude-opus-5", false, null);
    assert.equal(argvBase.includes("--mcp-config"), false);

    withTool.cleanup();
    baseline.cleanup();
  });
});

describe("credential lifetime", () => {
  test("an expired token is detected rather than assumed healthy", () => {
    const root = scratch("cred-expired");
    const file = path.join(root, "credentials.json");
    const now = Date.parse("2026-01-01T00:00:00Z");
    fs.writeFileSync(
      file,
      JSON.stringify({ claudeAiOauth: { accessToken: "x", expiresAt: now - 3_600_000 } })
    );

    const info = inspectCredentials(file, {}, now);
    assert.equal(info.source, "config-file");
    assert.equal(info.expired, true);
    assert.equal(info.remainingMs, -3_600_000);
    assert.equal(info.remainingHuman, "-1h00m");
  });

  test("a healthy token records how much life is left", () => {
    const root = scratch("cred-ok");
    const file = path.join(root, "credentials.json");
    const now = Date.parse("2026-01-01T00:00:00Z");
    fs.writeFileSync(
      file,
      JSON.stringify({ claudeAiOauth: { expiresAt: now + 5_400_000 } })
    );

    const info = inspectCredentials(file, {}, now);
    assert.equal(info.expired, false);
    assert.equal(info.remainingHuman, "1h30m");
  });

  test("a missing credential file is called out, not silently ignored", () => {
    const root = scratch("cred-missing");
    const info = inspectCredentials(path.join(root, "nope.json"), {}, Date.now());
    assert.equal(info.source, "none");
    assert.match(String(info.note), /fail to authenticate/);
  });

  test("an unparseable credential file yields unknown lifetime, not a crash", () => {
    const root = scratch("cred-broken");
    const file = path.join(root, "credentials.json");
    fs.writeFileSync(file, "{not json");
    const info = inspectCredentials(file, {}, Date.now());
    assert.equal(info.expired, false);
    assert.equal(info.remainingMs, null);
    assert.match(String(info.note), /could not be parsed/);
  });

  test("the lifetime is written into every run record", async () => {
    const root = scratch("cred-record");
    const scenario = makeScenarioDir(root);
    const credentialsPath = path.join(root, "credentials.json");
    fs.writeFileSync(
      credentialsPath,
      // 2h plus a margin, so the few ms the run takes cannot round the label down.
      JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 7_230_000 } })
    );

    const agent: SpawnAgentFn = async (req) => {
      // The credential must have been copied into the throwaway config.
      assert.ok(
        fs.existsSync(path.join(req.env.CLAUDE_CONFIG_DIR as string, ".credentials.json"))
      );
      fs.writeFileSync(
        req.transcriptFile,
        transcript([initLine(), assistantLine("m1", { output_tokens: 9 }), resultLine()])
      );
      fs.writeFileSync(req.stderrFile, "");
      return { exitCode: 0, signal: null, timedOut: false };
    };

    const { batchDir, batch } = await runBatch(scenario, {
      n: 1,
      outDir: path.join(root, "runs"),
      credentialsPath,
      tmpRoot: root,
      spawnAgent: agent,
      log: () => {},
    });

    const record = JSON.parse(
      fs.readFileSync(path.join(batchDir, batch.runDirs[0] as string, "run.json"), "utf8")
    ) as { credential: { copied: boolean; remainingHuman: string; expired: boolean } };
    assert.equal(record.credential.copied, true);
    assert.equal(record.credential.expired, false);
    assert.equal(record.credential.remainingHuman, "2h00m");
  });

  test("durations read the way a human would say them", () => {
    assert.equal(humanDuration(0), "0h00m");
    assert.equal(humanDuration(90 * 60 * 1000), "1h30m");
    assert.equal(humanDuration(-61 * 60 * 1000), "-1h01m");
  });
});
