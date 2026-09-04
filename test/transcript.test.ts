/**
 * Failure mode: streaming-duplicated usage blocks.
 *
 * Claude Code repeats the CUMULATIVE usage for a message across streaming
 * chunks. Summing every usage block it emits inflates the cost of every run,
 * and the inflation scales with how chatty the run was — which is exactly the
 * variable a cost delta is trying to measure.
 */

import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import { analyzeTranscriptText } from "../src/transcript";
import {
  assistantLine,
  bashCall,
  initLine,
  readCall,
  resultLine,
  TOOL,
  transcript,
} from "./helpers";

describe("cost dedup", () => {
  test("the terminal result line is authoritative when the run reached one", () => {
    // Mid-stream snapshots under-report output; the result line does not.
    const text = transcript([
      initLine(),
      assistantLine("msg_01", { input_tokens: 2, output_tokens: 6, cache_read_input_tokens: 9922 }),
      assistantLine("msg_02", { input_tokens: 2, output_tokens: 9, cache_read_input_tokens: 20873 }),
      resultLine("success", false, {
        input_tokens: 4,
        output_tokens: 2411,
        cache_read_input_tokens: 30795,
        cache_creation_input_tokens: 0,
      }),
    ]);

    const a = analyzeTranscriptText(text, TOOL);
    assert.equal(a.totalsSource, "result-line");
    assert.equal(a.totals.output, 2411, "must not report the mid-stream snapshot");
    // The deduped message figures are kept, and are exact for input and cache.
    assert.equal(a.messageTotals.output, 15);
    assert.equal(a.messageTotals.input, 4);
    assert.equal(a.messageTotals.cacheRead, 30795);
  });

  test("a run killed before its result line falls back to deduped message usage", () => {
    const text = transcript([
      initLine(),
      assistantLine("msg_01", { input_tokens: 2, output_tokens: 6, cache_read_input_tokens: 9922 }),
      assistantLine("msg_02", { input_tokens: 2, output_tokens: 9, cache_read_input_tokens: 20873 }),
    ]);
    const a = analyzeTranscriptText(text, TOOL);
    assert.equal(a.complete, false);
    assert.equal(a.totalsSource, "deduped-messages");
    assert.equal(a.totals.input, 4);
    assert.equal(a.resultTotals, null);
  });

  test("cumulative usage repeated across chunks is counted once, not summed", () => {
    // One logical message, emitted three times with growing cumulative usage.
    const text = transcript([
      initLine(),
      assistantLine("msg_01", { input_tokens: 100, output_tokens: 10 }),
      assistantLine("msg_01", { input_tokens: 100, output_tokens: 40 }),
      assistantLine("msg_01", { input_tokens: 100, output_tokens: 90 }),
      resultLine(),
    ]);

    const a = analyzeTranscriptText(text, TOOL);

    // Naive summation would give input 300 / output 140.
    assert.equal(a.totalsSource, "deduped-messages");
    assert.equal(a.totals.input, 100, "input must not be triple-counted");
    assert.equal(a.totals.output, 90, "output must be the final cumulative value");
    assert.equal(a.totals.total, 190);
    assert.equal(a.turns, 1, "three chunks of one message is one turn");
  });

  test("distinct messages still add up", () => {
    const text = transcript([
      initLine(),
      assistantLine("msg_01", { input_tokens: 100, output_tokens: 10 }),
      assistantLine("msg_01", { input_tokens: 100, output_tokens: 25 }),
      assistantLine("msg_02", { input_tokens: 200, output_tokens: 50 }),
      assistantLine("msg_03", {
        input_tokens: 5,
        output_tokens: 5,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 300,
      }),
      resultLine(),
    ]);

    const a = analyzeTranscriptText(text, TOOL);
    assert.equal(a.totals.input, 305);
    assert.equal(a.totals.output, 80);
    assert.equal(a.totals.cacheRead, 1000);
    assert.equal(a.totals.cacheCreation, 300);
    assert.equal(a.totals.total, 1685);
    assert.equal(a.turns, 3);
  });

  test("a repeated tool_use block is one invocation, not two", () => {
    const call = bashCall("toolu_01", "tools/phrasebook greeting fr");
    const text = transcript([
      initLine(),
      assistantLine("msg_01", { output_tokens: 10 }, [call]),
      assistantLine("msg_01", { output_tokens: 20 }, [call]),
      resultLine(),
    ]);

    const a = analyzeTranscriptText(text, TOOL);
    assert.equal(a.invocationCount, 1);
    assert.equal(a.invoked, true);
  });
});

describe("adoption vs. reading the docs", () => {
  test("reading SKILL.md is documentation, never adoption", () => {
    const text = transcript([
      initLine(),
      assistantLine("msg_01", { output_tokens: 10 }, [
        readCall("toolu_01", "/tmp/cfg/skills/phrasebook/SKILL.md"),
      ]),
      resultLine(),
    ]);

    const a = analyzeTranscriptText(text, TOOL);
    assert.equal(a.readDocs, true);
    assert.equal(a.documentationCount, 1);
    assert.equal(a.invoked, false, "reading the docs is not using the tool");
    assert.equal(a.invocationCount, 0);
  });

  test("running the tool is adoption", () => {
    const text = transcript([
      initLine(),
      assistantLine("msg_01", { output_tokens: 10 }, [
        readCall("toolu_01", "/tmp/cfg/skills/phrasebook/SKILL.md"),
        bashCall("toolu_02", "node tools/phrasebook greeting fr"),
      ]),
      resultLine(),
    ]);

    const a = analyzeTranscriptText(text, TOOL);
    assert.equal(a.invoked, true);
    assert.equal(a.invocationCount, 1);
    assert.equal(a.documentationCount, 1);
    const kinds = a.events.map((e) => e.kind);
    assert.deepEqual(kinds, ["documentation", "invocation"]);
  });

  test("loading a skill that only documents the tool is docs, not adoption", () => {
    // This is what the real agent does: it loads the Agent Skill to read about
    // the CLI, which is not the same as running the CLI.
    const text = transcript([
      initLine(),
      assistantLine("msg_01", { output_tokens: 10 }, [
        { type: "tool_use", id: "toolu_01", name: "Skill", input: { skill: "phrasebook", args: "fr greeting" } },
      ]),
      resultLine(),
    ]);

    const a = analyzeTranscriptText(text, {
      ...TOOL,
      documentation: { ...TOOL.documentation, skillNames: ["phrasebook"] },
    });
    assert.equal(a.readDocs, true);
    assert.equal(a.invoked, false, "loading the skill did not run anything");
    assert.equal(a.events[0]?.matchedBy, "documentation.skillNames:phrasebook");
  });

  test("a skill that IS the tool counts as adoption", () => {
    const text = transcript([
      initLine(),
      assistantLine("msg_01", { output_tokens: 10 }, [
        { type: "tool_use", id: "toolu_01", name: "Skill", input: { skill: "phrasebook" } },
      ]),
      resultLine(),
    ]);
    const a = analyzeTranscriptText(text, {
      ...TOOL,
      invocation: { skillNames: ["phrasebook"] },
      documentation: {},
    });
    assert.equal(a.invoked, true);
    assert.equal(a.readDocs, false);
  });

  test("an unrelated bash call is neither", () => {
    const text = transcript([
      initLine(),
      assistantLine("msg_01", { output_tokens: 10 }, [
        bashCall("toolu_01", "npm test"),
      ]),
      resultLine(),
    ]);

    const a = analyzeTranscriptText(text, TOOL);
    assert.equal(a.invoked, false);
    assert.equal(a.readDocs, false);
    assert.equal(a.events.length, 0);
  });

  test("mcp tool names match with a prefix wildcard", () => {
    const tool = {
      ...TOOL,
      invocation: { toolNames: ["mcp__phrasebook__*"] },
    };
    const text = transcript([
      initLine(),
      assistantLine("msg_01", { output_tokens: 10 }, [
        { type: "tool_use", id: "toolu_01", name: "mcp__phrasebook__lookup", input: {} },
        { type: "tool_use", id: "toolu_02", name: "mcp__other__lookup", input: {} },
      ]),
      resultLine(),
    ]);

    const a = analyzeTranscriptText(text, tool);
    assert.equal(a.invocationCount, 1);
    assert.equal(a.events[0]?.toolName, "mcp__phrasebook__lookup");
  });
});

describe("a call that fails is still adoption", () => {
  function toolResult(id: string, isError: boolean | undefined): string {
    return JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            ...(isError === undefined ? {} : { is_error: isError }),
            content: "…",
          },
        ],
      },
    });
  }

  test("an errored tool call counts as adoption and is reported as failed", () => {
    // The real case this came from: the agent called the MCP tool, the tool
    // broke, and the agent fell back to the CLI — paying for both.
    const text = transcript([
      initLine(),
      assistantLine("msg_01", { output_tokens: 10 }, [
        bashCall("toolu_01", "tools/phrasebook greeting fr"),
      ]),
      toolResult("toolu_01", true),
      resultLine(),
    ]);

    const a = analyzeTranscriptText(text, TOOL);
    assert.equal(a.invoked, true, "the agent did call the tool");
    assert.equal(a.invocationCount, 1);
    assert.equal(a.invocationFailures, 1);
    assert.equal(a.events[0]?.failed, true);
  });

  test("a successful call is not counted as a failure", () => {
    const text = transcript([
      initLine(),
      assistantLine("msg_01", { output_tokens: 10 }, [
        bashCall("toolu_01", "tools/phrasebook greeting fr"),
      ]),
      toolResult("toolu_01", false),
      resultLine(),
    ]);
    const a = analyzeTranscriptText(text, TOOL);
    assert.equal(a.invocationFailures, 0);
    assert.equal(a.events[0]?.failed, false);
  });

  test("an absent is_error means success, not unknown", () => {
    const text = transcript([
      initLine(),
      assistantLine("msg_01", { output_tokens: 10 }, [
        bashCall("toolu_01", "tools/phrasebook greeting fr"),
      ]),
      toolResult("toolu_01", undefined),
      resultLine(),
    ]);
    const a = analyzeTranscriptText(text, TOOL);
    assert.equal(a.events[0]?.failed, false);
    assert.equal(a.invocationFailures, 0);
  });

  test("a call with no result at all is unknown, not success", () => {
    // The run was cut off before the tool answered.
    const text = transcript([
      initLine(),
      assistantLine("msg_01", { output_tokens: 10 }, [
        bashCall("toolu_01", "tools/phrasebook greeting fr"),
      ]),
    ]);
    const a = analyzeTranscriptText(text, TOOL);
    assert.equal(a.events[0]?.failed, null);
    assert.equal(a.invocationFailures, 0, "unknown must not be counted as failed");
    assert.equal(a.invoked, true);
  });
});

describe("malformed and truncated transcripts", () => {
  test("a truncated final line makes the transcript unparseable rather than crashing", () => {
    const good = transcript([
      initLine(),
      assistantLine("msg_01", { input_tokens: 100, output_tokens: 50 }),
    ]);
    const truncated = good + '{"type":"assis';

    const a = analyzeTranscriptText(truncated, TOOL);
    assert.equal(a.parseable, false);
    assert.equal(a.malformedLines, 1);
    assert.equal(a.complete, false);
    assert.ok(a.parseErrors.length > 0);
    // It still reports what it could read, so the run is diagnosable.
    assert.equal(a.parsedLines, 2);
  });

  test("a complete transcript is parseable and complete", () => {
    const a = analyzeTranscriptText(
      transcript([initLine(), assistantLine("msg_01", { output_tokens: 5 }), resultLine()]),
      TOOL
    );
    assert.equal(a.parseable, true);
    assert.equal(a.complete, true);
    assert.equal(a.malformedLines, 0);
  });

  test("a killed run has a parseable but incomplete transcript", () => {
    const a = analyzeTranscriptText(
      transcript([initLine(), assistantLine("msg_01", { output_tokens: 5 })]),
      TOOL
    );
    assert.equal(a.parseable, true);
    assert.equal(a.complete, false, "no result line means the agent never finished");
  });

  test("an empty transcript is not parseable", () => {
    const a = analyzeTranscriptText("", TOOL);
    assert.equal(a.parseable, false);
    assert.equal(a.totals.total, 0);
  });

  test("a missing file is reported, not thrown", () => {
    const { analyzeTranscriptFile } = require("../src/transcript");
    const a = analyzeTranscriptFile("/nonexistent/nope.jsonl", TOOL);
    assert.equal(a.exists, false);
    assert.equal(a.parseable, false);
  });
});

describe("CLI-shaped tools: listing is not using", () => {
  const CLI_TOOL = {
    name: "mate",
    enable: { fixtureFiles: ["../_tool/mate"] },
    invocation: { bashPatterns: ["vendor/bin/mate\\s+tools:call"] },
    documentation: { bashPatterns: ["vendor/bin/mate\\s+tools:(list|inspect)"] },
  };

  test("`tools:call` is an invocation", () => {
    const a = analyzeTranscriptText(
      transcript([
        initLine(),
        assistantLine("m1", { output_tokens: 5 }, [
          bashCall("t1", "vendor/bin/mate tools:call phpunit-run --format=json"),
        ]),
        resultLine(),
      ]),
      CLI_TOOL
    );
    assert.equal(a.invoked, true);
    assert.equal(a.invocationCount, 1);
    assert.equal(a.documentationCount, 0);
  });

  test("`tools:list` is documentation, not adoption", () => {
    const a = analyzeTranscriptText(
      transcript([
        initLine(),
        assistantLine("m1", { output_tokens: 5 }, [
          bashCall("t1", "vendor/bin/mate tools:list"),
        ]),
        resultLine(),
      ]),
      CLI_TOOL
    );
    assert.equal(a.invoked, false, "listing the surface is not using it");
    assert.equal(a.readDocs, true);
    assert.equal(a.documentationCount, 1);
  });

  test("a command matching both stays an invocation", () => {
    const both = {
      ...CLI_TOOL,
      documentation: { bashPatterns: ["vendor/bin/mate"] },
    };
    const a = analyzeTranscriptText(
      transcript([
        initLine(),
        assistantLine("m1", { output_tokens: 5 }, [
          bashCall("t1", "vendor/bin/mate tools:call phpstan-analyse"),
        ]),
        resultLine(),
      ]),
      both
    );
    assert.equal(a.invocationCount, 1);
    assert.equal(a.documentationCount, 0);
  });
});

describe("a shell-masked exit status is unknown, not success", () => {
  const CLI_TOOL = {
    name: "mate",
    enable: { fixtureFiles: ["../_tool/mate"] },
    invocation: { bashPatterns: ["mate\\s+tools:call"] },
  };

  function run(command: string, isError: boolean | undefined) {
    return analyzeTranscriptText(
      transcript([
        initLine(),
        assistantLine("m1", { output_tokens: 5 }, [bashCall("t1", command)]),
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                ...(isError === undefined ? {} : { is_error: isError }),
                content: "…",
              },
            ],
          },
        }),
        resultLine(),
      ]),
      CLI_TOOL
    );
  }

  test("a bare command is scored normally", () => {
    const a = run("vendor/bin/mate tools:call phpstan-analyse", true);
    assert.equal(a.invocationFailures, 1);
    assert.equal(a.invocationDeterminate, 1);
    assert.equal(a.invocationStatusUnknown, 0);
  });

  test("a piped command reports success it cannot vouch for — so it is unknown", () => {
    // `... | head` exits with head's status. This exact pattern made a tool
    // that failed 100% of the time read as 27%.
    const a = run("vendor/bin/mate tools:call phpstan-analyse 2>&1 | head -20", false);
    assert.equal(a.invoked, true, "it is still adoption");
    assert.equal(a.invocationStatusUnknown, 1);
    assert.equal(a.invocationDeterminate, 0);
    assert.equal(a.invocationFailures, 0, "unknown must not be counted as a failure either");
    assert.equal(a.events[0]?.statusMasked, true);
    assert.equal(a.events[0]?.failed, null);
  });

  test("`||` and `;` mask the status too", () => {
    for (const cmd of [
      "vendor/bin/mate tools:call x || echo failed",
      "vendor/bin/mate tools:call x; echo done",
    ]) {
      const a = run(cmd, false);
      assert.equal(a.invocationStatusUnknown, 1, cmd);
    }
  });

  test("a separator inside a quoted string does not count as masking", () => {
    const a = run("vendor/bin/mate tools:call monolog-search --term='a | b'", true);
    assert.equal(a.events[0]?.statusMasked, false);
    assert.equal(a.invocationFailures, 1);
  });

  test("2>&1 alone does not mask the status", () => {
    const a = run("vendor/bin/mate tools:call phpstan-analyse 2>&1", true);
    assert.equal(a.events[0]?.statusMasked, false);
    assert.equal(a.invocationFailures, 1);
  });
});
