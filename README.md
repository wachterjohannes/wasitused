# wasitused

**promptfoo tests your prompts. This tests your tools.**

You shipped an MCP server, an Agent Skill, or a CLI for coding agents. You can
tell it works when it is called. What you cannot tell is whether the agent ever
*chooses* to call it — and whether calling it made the outcome any better.

`wasitused` runs a coding agent on the same task twice, once with your tool
available and once without, then reads the transcripts back and tells you:

- **Adoption** — did the agent actually *invoke* the tool? (Reading its docs
  does not count, and is tracked as a separate event.)
- **Efficacy delta** — pass rate with the tool vs. without, from a
  machine-verifiable check against the artifact the agent left behind.
- **Cost delta** — tokens, turns and wall clock, with vs. without.
- **Over-use** — invocations in tasks where the tool cannot possibly help.

Every effect is reported **conditioned on actual invocation**. A tool that was
never called cannot have caused the difference you are looking at, and the
report says so rather than letting you read a win into it.

> **Status: early.** The runner loop, metrics and reporting work end to end
> against Claude Code. The numbers in this README come from the bundled example
> and are a demonstration, not a benchmark result.

---

## Quickstart

```bash
git clone https://github.com/wachterjohannes/wasitused.git
cd wasitused
npm install && npm run build

# See exactly what would be spawned, without spending a run:
node bin/wasitused.js run scenarios/greeting-locale/scenario.json --dry-run

# Run it for real: 5 runs with the tool, 5 without.
node bin/wasitused.js run scenarios/greeting-locale/scenario.json -n 5
```

That writes a batch directory under `runs/` containing every transcript, every
artifact, `metrics.json` and a self-contained `report.html`.

Metrics are a **separate pass** over the stored files, so you can change how
something is measured and recompute without paying for the runs again:

```bash
node bin/wasitused.js report runs/<batch-id>
```

<!-- TODO: demo GIF of a run + the resulting report -->

## What a run looks like

The bundled `greeting-locale` example is a tiny CLI that needs a French locale
added. The reviewed French greeting has a space before the exclamation mark;
the tool under test knows that and the agent otherwise has to guess:

```
with_tool-001: exit=0 tokens=173858 turns=9 invoked=true  solved=true   29s
baseline-001:  exit=0 tokens=118505 turns=6 invoked=false solved=false  37s
...
```

| | with tool | baseline |
| --- | --- | --- |
| Adoption | 5/5 | 0/5 |
| Pass rate | 5/5 | 2/5 |
| Mean total tokens | 154,477 | 133,043 |

The bundled `digit-sum` example is the other half of the picture: a pure
algorithm task the tool cannot help with. There, adoption is 0/5 — but the
with-tool condition still burns ~16k more tokens per run just from the tool
being present. That is what the over-use metric is for.

Both are toy examples. They exist so the mechanism is legible and testable, not
to tell you anything about tools in general.

## Commands

| | |
| --- | --- |
| `wasitused run <scenario.json>` | Run the scenario with and without the tool |
| `wasitused report <batch-dir>` | Recompute metrics from stored transcripts, write `report.html` |
| `wasitused metrics <batch-dir>` | Print metrics as JSON |
| `wasitused validate <scenario.json>` | Check a scenario config without running it |

Useful flags: `-n` runs per condition (default 5), `-o` output directory,
`--model` to override the pinned model, `--dry-run` to print the spawn plan,
`--keep-temp` to keep each run's temp dir for debugging.

## Writing a scenario

A scenario is one JSON file plus a fixture directory. There is no DSL and no
plugin system, on purpose.

```jsonc
{
  "id": "greeting-locale",
  "toolRelevant": true,          // false = the tool cannot help; measures over-use
  "prompt": "...",               // never mentions the tool — see below
  "fixture": "fixture",          // copied fresh into a temp dir per run
  "check": { "command": "node \"$WASITUSED_SCENARIO_DIR/check.mjs\"" },
  "agent": { "model": "claude-opus-5", "maxTurns": 30, "timeoutMs": 600000 },

  "tool": {
    "name": "phrasebook",

    // How the tool is switched on for the with_tool condition.
    "enable": {
      "skills": ["../phrasebook-tool/skills/phrasebook"],  // -> isolated CLAUDE_CONFIG_DIR/skills/
      "fixtureFiles": ["../phrasebook-tool/tools"],        // -> the agent's working copy
      "mcpServers": { },                                   // -> --mcp-config --strict-mcp-config
      "env": { },
      "appendSystemPrompt": ""
    },

    // What counts as actually calling it.
    "invocation": { "bashPatterns": ["tools[/\\\\]phrasebook"] },

    // What counts as only reading about it. Never merged with the above.
    "documentation": {
      "pathPatterns": ["phrasebook[/\\\\]SKILL\\.md"],
      "skillNames": ["phrasebook"]
    }
  }
}
```

The success check reports **exit 0 = solved, exit 1 = not solved, anything else
= indeterminate**. Indeterminate is recorded as `solved: null` and is never
counted as a failure.

Two rules the bundled examples follow, and you should too:

- **The prompt must not mention the tool.** If it does, you are measuring
  instruction-following, not adoption. The only difference between conditions
  is whether the tool exists.
- **The check lives outside the fixture.** So does whatever it compares
  against. The agent must not be able to read the answer or edit the thing that
  grades it.

See [`scenarios/README.md`](scenarios/README.md) for the full layout.

## Isolation

The harness spawns the agent it is measuring, which is where most of the real
risk lives. Every run gets:

- a **fresh, bare `CLAUDE_CONFIG_DIR`** in a temp dir — never your `~/.claude`,
  so your own skills, `CLAUDE.md` and memory cannot leak into the baseline;
- **every inherited `CLAUDE_*` variable stripped**, with the list of what was
  stripped written into the run record;
- a **fresh copy of the fixture outside this repo** — the agent never runs in
  the harness's own working tree;
- **credentials copied in fresh, with their remaining lifetime recorded.** An
  expired token produces a run that looks perfectly legitimate — exit 0, one
  turn, zero cost — and is indistinguishable from "the model did nothing
  useful" unless the lifetime is on record.

If three consecutive runs produce zero billable tokens, the batch **aborts
loudly** rather than letting dud rows be counted as failures.

## Prior art

There is real work in this space, and it mostly answers a different question.

Benchmarks like [MCP-Bench](https://arxiv.org/abs/2508.20453),
[MCP-AgentBench](https://arxiv.org/pdf/2509.09734),
[MCPToolBench++](https://arxiv.org/pdf/2508.07575) and
[OSWorld-MCP](https://arxiv.org/abs/2510.24563) put **the agent** under test
against a fixed suite of servers: how good is this model at using tools?
OSWorld-MCP in particular reports a Tool Invocation Rate, so invocation
propensity is not unmeasured ground.

Tool-author-facing frameworks like
[mcp-eval](https://github.com/lastmile-ai/mcp-eval) and
[MCPEval](https://arxiv.org/pdf/2507.12806) do put **your server** under test,
but they evaluate correctness *given* that the tool is called — there is no
no-tool baseline to compare against.

What this project does that those do not: hold the agent and the task fixed,
vary **only whether your tool exists**, and report adoption, efficacy, cost and
over-use from that A/B — with every effect conditioned on whether the tool was
actually invoked. It is a tool-author's harness for their own repository
fixtures, not a leaderboard for models.

## Design notes

The reasoning behind the metric definitions, the pilot gate, ground-truth
discipline and the failure modes this harness is built to survive is in
[METHODOLOGY.md](METHODOLOGY.md). It is worth reading before you quote a number
at anyone.

## Non-goals

No scenario DSL. No plugin architecture. No multi-agent adapter layer. No web
UI. No SaaS. Claude Code is the only supported agent until the loop is proven.

## Requirements

Node ≥ 20, and the [Claude Code](https://claude.com/claude-code) CLI on your
`PATH`, authenticated.

## Development

```bash
npm test        # builds, then runs the test suite
```

The suite deliberately exercises the failure modes above — broken credentials,
truncated transcripts, streaming-duplicated usage, indeterminate checks — and
asserts the harness flags them rather than quietly miscounting.

## License

MIT — see [LICENSE](LICENSE).
