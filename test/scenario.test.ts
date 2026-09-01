/**
 * Failure mode: a config field that is silently ignored.
 *
 * A typo in a matcher name does not crash anything — it just means the harness
 * never detects an invocation, and every run reports honest-looking zeros.
 * Validation is strict so that mistake is loud and immediate.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import { test, describe, after } from "node:test";
import * as path from "node:path";
import { loadScenario, ScenarioValidationError, validateScenario } from "../src/scenario";
import { PRICING } from "../src/pricing";
import { scenarioConfig, tmpDir } from "./helpers";

const created: string[] = [];
function scratch(name: string): string {
  const dir = tmpDir(name);
  created.push(dir);
  return dir;
}
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function problemsFor(raw: unknown): string[] {
  try {
    validateScenario(raw, "test.json");
    return [];
  } catch (err) {
    assert.ok(err instanceof ScenarioValidationError);
    return err.problems;
  }
}

describe("scenario validation", () => {
  test("a valid scenario passes and gets defaults", () => {
    const config = validateScenario(
      {
        id: "example",
        toolRelevant: true,
        prompt: "do it",
        fixture: "fixture",
        check: { command: "true" },
        tool: {
          name: "phrasebook",
          enable: { skills: ["./skill"] },
          invocation: { bashPatterns: ["phrasebook"] },
        },
      },
      "test.json"
    );
    assert.equal(config.agent.model, "claude-opus-5");
    assert.equal(config.agent.maxTurns, 40);
    assert.equal(config.check.timeoutMs, 60000);
  });

  test("a misspelled field is an error, not a shrug", () => {
    const raw = { ...scenarioConfig(), toolRelevent: true } as unknown;
    const problems = problemsFor(raw);
    assert.ok(problems.some((p) => p.includes('unknown field "toolRelevent"')));
  });

  test("a misspelled matcher key is caught before it costs a batch", () => {
    const base = scenarioConfig();
    const raw = {
      ...base,
      tool: { ...base.tool, invocation: { bashPattern: ["phrasebook"] } },
    } as unknown;
    const problems = problemsFor(raw);
    assert.ok(problems.some((p) => p.includes('unknown field "bashPattern"')));
  });

  test("a tool with no way to detect invocation is rejected", () => {
    const base = scenarioConfig();
    const raw = { ...base, tool: { ...base.tool, invocation: {} } } as unknown;
    const problems = problemsFor(raw);
    assert.ok(
      problems.some((p) => p.includes("adoption could never be detected")),
      "silently un-detectable adoption is the exact bug this guards against"
    );
  });

  test("a tool with no way to be switched on is rejected", () => {
    const base = scenarioConfig();
    const raw = { ...base, tool: { ...base.tool, enable: {} } } as unknown;
    const problems = problemsFor(raw);
    assert.ok(problems.some((p) => p.includes("identical to baseline")));
  });

  test("toolRelevant must be stated explicitly", () => {
    const raw = { ...scenarioConfig(), toolRelevant: undefined } as unknown;
    const problems = problemsFor(raw);
    assert.ok(problems.some((p) => p.startsWith("toolRelevant:")));
  });

  test("a skill cannot be both the tool and its documentation", () => {
    const base = scenarioConfig();
    const raw = {
      ...base,
      tool: {
        ...base.tool,
        invocation: { skillNames: ["phrasebook"] },
        documentation: { skillNames: ["phrasebook"] },
      },
    } as unknown;
    const problems = problemsFor(raw);
    assert.ok(problems.some((p) => p.includes("not both")));
  });

  test("an invalid regex is reported with its own message", () => {
    const base = scenarioConfig();
    const raw = {
      ...base,
      tool: { ...base.tool, invocation: { bashPatterns: ["phrase(book"] } },
    } as unknown;
    const problems = problemsFor(raw);
    assert.ok(problems.some((p) => p.includes("is not a valid regex")));
  });

  test("all problems are reported at once, not one per run", () => {
    const problems = problemsFor({ id: "Bad Id", prompt: "" });
    assert.ok(problems.length >= 4, `expected several problems, got ${problems.length}`);
  });

  test("a missing fixture directory is caught at load time", () => {
    const root = scratch("fixture-missing");
    const configPath = path.join(root, "scenario.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ ...scenarioConfig(), fixture: "does-not-exist" })
    );
    assert.throws(
      () => loadScenario(configPath),
      (err: unknown) =>
        err instanceof ScenarioValidationError &&
        err.problems.some((p) => p.includes("does not resolve to a directory"))
    );
  });

  test("a missing skill directory is caught at load time", () => {
    const root = scratch("skill-missing");
    fs.mkdirSync(path.join(root, "fixture"), { recursive: true });
    const configPath = path.join(root, "scenario.json");
    const base = scenarioConfig();
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        ...base,
        tool: { ...base.tool, enable: { skills: ["./nope"] } },
      })
    );
    assert.throws(
      () => loadScenario(configPath),
      (err: unknown) =>
        err instanceof ScenarioValidationError &&
        err.problems.some((p) => p.includes('"./nope" does not exist'))
    );
  });
});

describe("the shipped example scenarios", () => {
  const scenarioRoot = path.join(__dirname, "..", "..", "scenarios");

  for (const id of ["greeting-locale", "digit-sum"]) {
    test(`${id} loads and validates`, () => {
      const scenario = loadScenario(path.join(scenarioRoot, id, "scenario.json"));
      assert.equal(scenario.id, id);
      assert.ok(fs.existsSync(scenario.fixturePath));
    });

    test(`${id} keeps its success check outside the fixture`, () => {
      const scenario = loadScenario(path.join(scenarioRoot, id, "scenario.json"));
      const inFixture = fs.readdirSync(scenario.fixturePath);
      assert.equal(
        inFixture.includes("check.mjs"),
        false,
        "the agent must not be able to read or edit the thing that grades it"
      );
      assert.equal(inFixture.includes("expected"), false);
      assert.ok(fs.existsSync(path.join(scenario.dir, "check.mjs")));
    });

    test(`${id} pins a model the price table can cost`, () => {
      // A scenario pinning an unpriced model still runs, but every USD figure
      // it produces is null. Cheap to get wrong when swapping models.
      const scenario = loadScenario(path.join(scenarioRoot, id, "scenario.json"));
      assert.ok(
        PRICING[scenario.agent.model],
        `${scenario.agent.model} has no entry in the price table`
      );
    });

    test(`${id} does not name the tool in its prompt`, () => {
      const scenario = loadScenario(path.join(scenarioRoot, id, "scenario.json"));
      assert.equal(
        scenario.prompt.toLowerCase().includes(scenario.tool.name.toLowerCase()),
        false,
        "naming the tool in the prompt measures instruction-following, not adoption"
      );
    });
  }

  test("the example set includes a tool-irrelevant scenario for over-use", () => {
    const relevance = ["greeting-locale", "digit-sum"].map(
      (id) => loadScenario(path.join(scenarioRoot, id, "scenario.json")).toolRelevant
    );
    assert.ok(relevance.includes(true));
    assert.ok(relevance.includes(false), "over-use needs something to measure against");
  });
});
