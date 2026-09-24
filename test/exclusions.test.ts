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
import { test, describe, after } from "node:test";
import { computeBatchMetrics } from "../src/metrics";
import { assistantLine, bashCall, initLine, makeBatchDir, resultLine, tmpDir, transcript } from "./helpers";

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
