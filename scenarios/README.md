# Example scenarios

These two scenarios exist to demonstrate and test the harness end to end. They
are **not** a benchmark and their numbers are not a finding — they are a worked
example of the file layout you copy when you write your own.

| Scenario | `toolRelevant` | What it is for |
| --- | --- | --- |
| [`greeting-locale/`](greeting-locale) | `true` | The tool can genuinely help. Measures adoption and efficacy. |
| [`digit-sum/`](digit-sum) | `false` | The tool cannot possibly help. Measures **over-use**. |

Both run against the same made-up tool under test, [`phrasebook-tool/`](phrasebook-tool):

- `tools/phrasebook` — a tiny CLI that returns reviewed translations of house UI
  strings. It is what "invoking the tool" means here.
- `skills/phrasebook/SKILL.md` — an Agent Skill describing that CLI. Reading it
  is what "read the docs" means here.

Keeping those two things in separate files is the point: the harness records
`Read SKILL.md` and `Bash tools/phrasebook` as different events, and only the
second one counts as adoption.

## Layout of a scenario

```
<scenario>/
  scenario.json   config: prompt, fixture, check, how the tool is switched on
  fixture/        the small project the agent is dropped into (copied per run)
  check.mjs       the success check — deliberately OUTSIDE fixture/
  expected/       frozen expectations — also outside fixture/
```

`check.mjs` and `expected/` live outside `fixture/` so the agent can neither read
the answer nor edit the thing that grades it. The check is run with `cwd` set to
the agent's working copy and gets `WASITUSED_SCENARIO_DIR` in its environment so
it can find its frozen expectations.

## The check contract

| exit code | meaning |
| --- | --- |
| `0` | solved |
| `1` | not solved |
| anything else | **indeterminate** — recorded as `solved: null`, never as a failure |

## Two rules worth copying

**The prompt never mentions the tool.** If the task says "use the phrasebook",
you are measuring instruction-following, not adoption. The only difference
between the two conditions is whether the tool is there at all.

**The visible tests are not the check.** `digit-sum` ships a `test.mjs` inside
the fixture so the task reads naturally, but the real check runs its own frozen
cases from outside. An agent that edits the visible test to make it pass still
fails the check — ground truth comes from the artifact's behaviour, not from
anything the agent could have touched.
