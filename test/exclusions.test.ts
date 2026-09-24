/**
 * Failure modes: runs that must be excluded from metrics rather than counted.
 *
 * Both exclusions existed on paper before they existed in the metrics pass.
 * `isBrokenEnvironment` was written and unit-tested, and never called, so a
 * run whose shell returned nothing still counted as a failed attempt. These
 * tests go through computeBatchMetrics end to end, so a helper that is defined
 * but not wired in fails here.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { test, describe, after } from "node:test";
import { computeBatchMetrics } from "../src/metrics";
import { ProviderLimitError, runBatch } from "../src/runner";
import { assistantLine, bashCall, initLine, makeBatchDir, makeScenarioDir, resultLine, tmpDir, transcript } from "./helpers";

const created: string[] = [];
function scratch(name: string): string {
  const dir = tmpDir(name);
  created.push(dir);
  return dir;
}
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function silentShellRun(calls: number, silent: number): string {
  const lines: string[] = [initLine()];
  for (let i = 0; i < calls; i++) {
    lines.push(assistantLine(`msg_${i}`, { input_tokens: 1000, output_tokens: 10 }, [bashCall(`t${i}`, `echo ${i}`)]));
    lines.push(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: `t${i}`, content: i < silent ? "Exit code 1" : `${i}\n` }],
        },
      })
    );
  }
  lines.push(resultLine());
  return transcript(lines);
}

describe("broken-environment exclusion", () => {
  test("a run whose shell mostly returned nothing is excluded, not counted as a failure", () => {
    const root = scratch("broken");
    const dir = makeBatchDir(root, [
      { condition: "with_tool", index: 1, transcript: silentShellRun(12, 11), check: { solved: false } },
      { condition: "baseline", index: 1, transcript: silentShellRun(12, 0), check: { solved: true } },
    ]);
    const m = computeBatchMetrics(dir);
    const broken = m.runs.find((r) => r.runId === "with_tool-001");
    assert.equal(broken?.usable, false);
    assert.equal(broken?.exclusion, "broken-environment");
    assert.equal(m.conditions.with_tool.excluded.brokenEnvironment, 1);
    assert.equal(m.efficacy.withToolAll.n, 0, "the broken run must not enter the pass rate");
    const healthy = m.runs.find((r) => r.runId === "baseline-001");
    assert.equal(healthy?.usable, true);
  });
});

describe("sandbox-escape exclusion", () => {
  test("a run that saw the scenario's own directory is excluded", () => {
    const root = scratch("escape");
    const scenarioDir = "/srv/lab/scenarios/example";
    const leaked = transcript([
      initLine(),
      assistantLine("msg_1", { input_tokens: 1000, output_tokens: 10 }, [bashCall("t1", "grep -r ORD-1 /")]),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: `${scenarioDir}/expected/answer.txt:ORD-1 PSP-9` }],
        },
      }),
      resultLine(),
    ]);
    const clean = transcript([initLine(), assistantLine("msg_1", { input_tokens: 1000, output_tokens: 10 }), resultLine()]);
    const dir = makeBatchDir(
      root,
      [
        { condition: "with_tool", index: 1, transcript: leaked, check: { solved: true } },
        { condition: "baseline", index: 1, transcript: clean, check: { solved: true } },
      ],
      { scenarioConfigPath: `${scenarioDir}/scenario.json` }
    );
    const m = computeBatchMetrics(dir);
    const escaped = m.runs.find((r) => r.runId === "with_tool-001");
    assert.equal(escaped?.exclusion, "sandbox-escape");
    assert.equal(m.conditions.with_tool.excluded.sandboxEscape, 1);
    assert.equal(m.runs.find((r) => r.runId === "baseline-001")?.usable, true);
  });
});

describe("provider-error exclusion", () => {
  const capped = JSON.stringify({
    type: "result",
    subtype: "error",
    is_error: true,
    error: "you have reached your session usage limit, upgrade for higher limits",
    error_name: "APIError",
    api_error_status: 429,
    usage: { input_tokens: 30000, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    total_cost_usd: 0.005,
  });

  test("a run the provider cut off is excluded, not counted as an unsolved attempt", () => {
    const root = scratch("provider");
    const cut = transcript([initLine(), assistantLine("m1", { input_tokens: 30000, output_tokens: 300 }), capped]);
    const clean = transcript([initLine(), assistantLine("m1", { input_tokens: 1000, output_tokens: 10 }), resultLine()]);
    const dir = makeBatchDir(root, [
      { condition: "with_tool", index: 1, transcript: cut, check: { solved: false } },
      { condition: "baseline", index: 1, transcript: clean, check: { solved: true } },
    ]);
    const m = computeBatchMetrics(dir);
    assert.equal(m.runs.find((r) => r.runId === "with_tool-001")?.exclusion, "provider-error");
    assert.equal(m.conditions.with_tool.excluded.providerError, 1);
    assert.equal(m.efficacy.withToolAll.n, 0);
  });

  test("running out of turns is the model's failure and stays counted", () => {
    const root = scratch("maxturns");
    const maxTurns = JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      usage: { input_tokens: 90000, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      total_cost_usd: 0.3,
    });
    const dir = makeBatchDir(root, [
      { condition: "with_tool", index: 1, transcript: transcript([initLine(), assistantLine("m1", { input_tokens: 90000, output_tokens: 900 }), maxTurns]), check: { solved: false } },
      { condition: "baseline", index: 1, transcript: transcript([initLine(), assistantLine("m1", { input_tokens: 1000, output_tokens: 10 }), resultLine()]), check: { solved: true } },
    ]);
    const m = computeBatchMetrics(dir);
    const r = m.runs.find((x) => x.runId === "with_tool-001");
    assert.equal(r?.usable, true);
    assert.equal(r?.solved, false);
  });

  test("the batch stops at the first capped run instead of burning through the rest", async () => {
    const root = scratch("provider-abort");
    const scenario = makeScenarioDir(root);
    let runs = 0;
    const err = await runBatch(scenario, {
      n: 5,
      outDir: path.join(root, "runs"),
      credential: { kind: "file", path: path.join(root, "none.json") },
      tmpRoot: root,
      spawnAgent: async (req) => {
        runs++;
        fs.writeFileSync(req.transcriptFile, transcript([initLine(), assistantLine(`m${runs}`, { input_tokens: 30000, output_tokens: 300 }), capped]));
        fs.writeFileSync(req.stderrFile, "");
        return { exitCode: 1, signal: null, timedOut: false };
      },
      log: () => {},
    }).then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(err instanceof ProviderLimitError);
    assert.equal(runs, 1);
  });
});
