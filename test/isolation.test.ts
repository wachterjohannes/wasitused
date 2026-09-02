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
  OAUTH_TOKEN_ENV,
  prepareIsolatedRun,
  resolveCredentialSource,
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
      credential: { kind: "file" as const, path: path.join(root, "credentials.json") },
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
      credential: { kind: "file" as const, path: path.join(root, "nope.json") },
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
      credential: { kind: "file" as const, path: path.join(root, "nope.json") },
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
      credential: { kind: "file" as const, path: path.join(root, "nope.json") },
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
      credential: { kind: "file" as const, path: path.join(root, "nope.json") },
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

    const info = inspectCredentials({ kind: "file", path: file }, {}, now);
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

    const info = inspectCredentials({ kind: "file", path: file }, {}, now);
    assert.equal(info.expired, false);
    assert.equal(info.remainingHuman, "1h30m");
  });

  test("a missing credential file is called out, not silently ignored", () => {
    const root = scratch("cred-missing");
    const info = inspectCredentials({ kind: "file", path: path.join(root, "nope.json") }, {}, Date.now());
    assert.equal(info.source, "none");
    assert.match(String(info.note), /fail to authenticate/);
  });

  test("an unparseable credential file yields unknown lifetime, not a crash", () => {
    const root = scratch("cred-broken");
    const file = path.join(root, "credentials.json");
    fs.writeFileSync(file, "{not json");
    const info = inspectCredentials({ kind: "file", path: file }, {}, Date.now());
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
      credential: { kind: "file" as const, path: credentialsPath },
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

  test("a long-lived token reports its lifetime as unknown, never as healthy", () => {
    const info = inspectCredentials({
      kind: "oauth-token",
      token: "sk-ant-oat01-secret",
      origin: "$CLAUDE_CODE_OAUTH_TOKEN",
    });
    assert.equal(info.source, "oauth-token");
    assert.equal(info.lifetimeKnown, false);
    assert.equal(info.remainingMs, null);
    assert.equal(
      info.expired,
      false,
      "unknown is not expired — but it is also not a claim of health"
    );
    assert.match(String(info.note), /unknown rather than assumed healthy/);
    assert.ok(
      !JSON.stringify(info).includes("sk-ant-oat01-secret"),
      "the credential record must never carry the token itself"
    );
  });

  test("a readable file expiry is still reported as known", () => {
    const root = scratch("cred-known");
    const file = path.join(root, "credentials.json");
    const now = Date.parse("2026-01-01T00:00:00Z");
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { expiresAt: now + 3_600_000 } }));
    assert.equal(inspectCredentials({ kind: "file", path: file }, {}, now).lifetimeKnown, true);
  });

  test("a file with no readable expiry is unknown, not healthy", () => {
    const root = scratch("cred-noexpiry");
    const file = path.join(root, "credentials.json");
    fs.writeFileSync(file, JSON.stringify({ something: "else" }));
    const info = inspectCredentials({ kind: "file", path: file }, {}, Date.now());
    assert.equal(info.lifetimeKnown, false);
    assert.equal(info.expired, false);
  });

  test("durations read the way a human would say them", () => {
    assert.equal(humanDuration(0), "0h00m");
    assert.equal(humanDuration(90 * 60 * 1000), "1h30m");
    assert.equal(humanDuration(-61 * 60 * 1000), "-1h01m");
  });
});

describe("choosing a credential source", () => {
  test("an explicit --credentials path wins over a token in the environment", () => {
    const source = resolveCredentialSource({
      credentialsPath: "/tmp/explicit.json",
      env: { [OAUTH_TOKEN_ENV]: "sk-ant-oat01-env" },
    });
    assert.equal(source.kind, "file");
    assert.equal(source.path, "/tmp/explicit.json");
  });

  test("a token in the environment is used when no file is named", () => {
    const source = resolveCredentialSource({
      env: { [OAUTH_TOKEN_ENV]: "  sk-ant-oat01-env  " },
    });
    assert.equal(source.kind, "oauth-token");
    assert.equal(source.token, "sk-ant-oat01-env", "surrounding whitespace is trimmed");
    assert.equal(source.origin, `$${OAUTH_TOKEN_ENV}`);
  });

  test("a token file is read and its origin recorded", () => {
    const root = scratch("cred-tokenfile");
    const file = path.join(root, "token");
    fs.writeFileSync(file, "sk-ant-oat01-fromfile\n");
    const source = resolveCredentialSource({ oauthTokenFile: file, env: {} });
    assert.equal(source.kind, "oauth-token");
    assert.equal(source.token, "sk-ant-oat01-fromfile");
    assert.match(String(source.origin), /token$/);
  });

  test("an empty token file is an error rather than a silent no-auth run", () => {
    const root = scratch("cred-emptytoken");
    const file = path.join(root, "token");
    fs.writeFileSync(file, "   \n");
    assert.throws(() => resolveCredentialSource({ oauthTokenFile: file, env: {} }), /empty/);
  });

  test("an empty environment variable does not count as a token", () => {
    const source = resolveCredentialSource({
      env: { [OAUTH_TOKEN_ENV]: "   " },
      home: "/home/nobody",
    });
    assert.equal(source.kind, "file", "falls through to the default credential file");
  });

  test("with nothing set it falls back to the default credential file", () => {
    const source = resolveCredentialSource({ env: {}, home: "/home/nobody" });
    assert.equal(source.kind, "file");
    assert.equal(source.path, path.join("/home/nobody", ".claude", ".credentials.json"));
  });
});

describe("token auth never touches disk", () => {
  const TOKEN = "sk-ant-oat01-THIS-MUST-NEVER-BE-PERSISTED";

  test("the token reaches the agent's environment and nothing else", async () => {
    const root = scratch("token-leak");
    const scenario = makeScenarioDir(root);
    let sawTokenInEnv = false;

    const agent: SpawnAgentFn = async (req) => {
      sawTokenInEnv = req.env[OAUTH_TOKEN_ENV] === TOKEN;
      // Stripping must still have removed everything else CLAUDE_*.
      assert.equal(req.env.CLAUDE_CODE_SESSION_ID, undefined);
      // No credentials file is written for token auth.
      assert.equal(
        fs.existsSync(path.join(req.env.CLAUDE_CONFIG_DIR as string, ".credentials.json")),
        false,
        "a token must not be materialised into the config dir"
      );
      assert.ok(
        !req.argv.some((a) => a.includes(TOKEN)),
        "a token in argv would be visible to every process on the machine"
      );
      fs.writeFileSync(
        req.transcriptFile,
        transcript([initLine(), assistantLine("m1", { output_tokens: 9 }), resultLine()])
      );
      fs.writeFileSync(req.stderrFile, "");
      return { exitCode: 0, signal: null, timedOut: false };
    };

    const { batchDir } = await runBatch(scenario, {
      n: 1,
      outDir: path.join(root, "runs"),
      credential: { kind: "oauth-token", token: TOKEN, origin: "$TEST" },
      tmpRoot: root,
      spawnAgent: agent,
      log: () => {},
    });

    assert.equal(sawTokenInEnv, true, "the agent must actually receive the credential");

    // Sweep every file the batch persisted.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (fs.readFileSync(full, "utf8").includes(TOKEN)) offenders.push(full);
      }
    };
    walk(batchDir);
    assert.deepEqual(offenders, [], "the token leaked into stored artifacts");
  });

  test("the run record names the credential source without carrying the secret", async () => {
    const root = scratch("token-record");
    const scenario = makeScenarioDir(root);
    const agent: SpawnAgentFn = async (req) => {
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
      credential: { kind: "oauth-token", token: TOKEN, origin: "$CLAUDE_CODE_OAUTH_TOKEN" },
      tmpRoot: root,
      spawnAgent: agent,
      log: () => {},
    });

    const record = JSON.parse(
      fs.readFileSync(path.join(batchDir, batch.runDirs[0] as string, "run.json"), "utf8")
    ) as { credential: { source: string; origin: string; lifetimeKnown: boolean } };
    assert.equal(record.credential.source, "oauth-token");
    assert.equal(record.credential.origin, "$CLAUDE_CODE_OAUTH_TOKEN");
    assert.equal(
      record.credential.lifetimeKnown,
      false,
      "a run under token auth must record that its credential lifetime was unknowable"
    );
  });
});
