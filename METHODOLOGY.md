# Methodology

Why this harness measures what it measures, and why it refuses to measure some
things at all.

Most of what follows is not clever. It is a list of ways a tool-evaluation
harness produces confident, clean-looking numbers that are wrong — and the
specific thing this codebase does about each one. Every failure mode in here
has a test in `test/` that deliberately triggers it and asserts the harness
flags it rather than counting it.

---

## 1. Adoption is invocation, not exposure

The question "does the agent use my tool?" has three different answers
depending on where you draw the line:

1. The tool was *available* to the agent.
2. The agent *read about* the tool — loaded the skill, read the docs, saw the
   tool description in its system prompt.
3. The agent *called* the tool.

Only (3) is adoption. (2) looks like adoption in a transcript if you are not
careful, especially with Agent Skills, where loading the skill is itself a tool
call. In the very first real run against the bundled example, the agent invoked
the `Skill` tool to load a skill that merely *describes* a CLI, then separately
ran the CLI. A parser that counted `Skill` as adoption would have been right by
accident there and wrong for every tool whose skill is documentation only.

So invocation and documentation are separate event kinds in the parser, matched
by separate config, and validation rejects a scenario that puts the same skill
in both. Build the distinction in on day one; retrofitting it means re-reading
every transcript you have.

**A shell can hide a tool's failure.** When the tool is a CLI, the agent often
wraps it: `mate tools:call phpstan-analyse | head -20`. That pipeline exits with
`head`'s status, so the harness sees success for a call that failed. This is not
hypothetical — it produced a wrong headline in this project's own work. A tool
that failed **100%** of the time was reported at **27%**, and a later run at
**85%**, purely because the two conditions piped the command at different rates
(73% vs 15%). The apparent "regression" was entirely an artifact.

So an invocation whose exit status the shell may not own is scored **unknown**,
never success: it is excluded from the failure rate's denominator and counted
separately. The detection is deliberately conservative — any pipeline or
command separator marks the call unknown, even where the status would in fact
have survived. Losing a little precision costs nothing; inventing successes
costs a finding.

**A call that errors is still a call.** Adoption asks whether the agent chose to
invoke the tool, and it chose whether or not the tool then worked. So a failed
invocation counts toward adoption — but it is reported separately, because the
two mean opposite things to a tool author. This is not hypothetical: in a real
run the agent found the MCP tool, called it, got `is_error: true`, fell back to
the raw CLI and finished the task — spending 20% more tokens than the baseline
that never had the tool at all. Collapsing that into "adopted, and cost went up"
would read as *the tool is expensive* when the finding is *the tool is broken*.
Absent `is_error` means success; **no result at all** means unknown, and unknown
is not counted as either.

**Corollary:** the scenario prompt must never mention the tool. If the prompt
says "use the phrasebook", the adoption number measures instruction-following.
The only difference between the two conditions should be whether the tool
exists at all.

## 2. Every effect must be conditioned on invocation

This is the single most expensive mistake available in this space.

You run 10 with-tool and 10 baseline. The with-tool condition costs 3.5× more.
You write that down as "the tool is expensive". Then you check the transcripts
and find the tool was invoked in 10/10 of one condition and 0/10 of the other —
the entire effect was the invocation, not the tool's efficiency.

So every delta this harness reports is accompanied by:

- the invocation count in each condition, as a required field, not a footnote;
- the delta computed over **all** usable with-tool runs, *and* over the subset
  that actually invoked the tool, side by side;
- an explicit note when invocation was 0, stating that no difference can be
  attributed to the tool.

The two deltas are shown together deliberately. When they diverge, that gap is
the finding.

The bundled `digit-sum` example shows the mirror case: adoption is 0/5, and the
with-tool condition still burns ~16k more tokens per run purely because the
tool's description is in the context. That is a real cost of shipping a tool —
and it is emphatically not a cost *of calling* it. The report keeps those
separable.

## 3. Ground truth comes from the artifact, never from the agent

Agents report success. They are wrong often enough, and confidently enough,
that "the agent said it worked" is not a measurement.

Every scenario's check runs against the working copy the agent left behind: it
executes the CLI, imports the module, reads the file. It never parses the
agent's summary.

Two consequences the bundled examples demonstrate:

- **Freeze the expectation.** What the check compares against is a fixed file
  in the scenario directory, written once, not computed at run time. A check
  that derives its own expected value can drift into agreeing with whatever the
  agent produced.
- **Keep the check away from the agent.** `check.mjs` and `expected/` live
  outside `fixture/`, so the agent can neither read the answer nor edit its
  own grader.
- **Do not verify a check against a solution built the same way as its
  expectation.** This one cost a scenario. A frozen expectation was generated by
  piping a command through `awk` and taking the first column; the "known-good
  solution" used to prove the check could pass was generated by the same
  pipeline. Both dropped the same column, so both were wrong in the same way and
  the check verified perfectly. The pilot then reported a confident 0/10 floor
  for a task the agent had actually got right every single time. Derive the
  expectation and the verification from **independent** sources — here, parsing
  the lockfile versus running the CLI — and require them to agree. The `digit-sum` fixture ships a *visible* test file so the task
  reads naturally, but the real check runs a superset of frozen cases from
  outside — editing the visible test into passing does not pass the check.

## 4. `solved: null` is not `solved: false`

A check that could not run, timed out, or could not determine an answer has
produced **no measurement**. Collapsing that into "failed" silently corrupts
every rate computed downstream, and it biases in a predictable direction:
infrastructure flakiness starts looking like the tool making things worse.

The check contract is therefore three-valued:

| exit code | meaning |
| --- | --- |
| `0` | solved |
| `1` | not solved |
| anything else | indeterminate — `solved: null` |

`null` runs are excluded from the pass-rate denominator, counted separately,
and named in the report's warnings. A rate over zero determinate runs is
reported as `null`, not as `0`.

## 5. Dud runs must abort the batch, not pad it

An expired credential does not produce an error you can see. It produces a run
with exit code 0, a well-formed transcript, one turn, and zero tokens. Nothing
about that row says "this is not a result". A batch of them becomes a column of
confident zeros.

Three defences, in order of how early they fire:

1. **Record the credential lifetime in every run record.** Not just at batch
   start — per run, because a long batch can outlive its own token. If you
   cannot tell afterwards how much life the credential had, you cannot tell a
   dud from a genuine failure.

   When the lifetime genuinely cannot be read — a long-lived token from
   `claude setup-token` carries no introspectable expiry — record it as
   **unknown**, and never as healthy. The tempting shortcut is to wrap the token
   in a synthetic credential file with a far-future expiry so the existing code
   path works unchanged. That writes a claim into every run record that nothing
   verified, and it disables the one signal that distinguishes "the agent did
   nothing useful" from "the credential was dead the whole time". Unknown is a
   worse answer than a real expiry and a much better one than a fabricated
   expiry; under token auth the dud guard is the whole defence, so it should be
   visible that it is.
2. **Exclude zero-cost runs from metrics** — as excluded, with a count, never
   as failures, and never silently dropped from the reported run total.
3. **Abort the batch after three consecutive zero-cost runs**, with an error
   that names the likely causes and points at the stderr log. Three in a row is
   not bad luck; it is a broken setup, and continuing only spends money to
   manufacture noise.

## 6. Transcript arithmetic is not obvious

Two traps, both measured against real transcripts rather than assumed:

**Streaming repeats cumulative usage.** One logical assistant message appears
several times in the stream, each time carrying the running total for that
message. Summing every `usage` block you see inflates cost, and it inflates it
*more* for chattier runs — which is exactly the variable a cost delta is trying
to isolate. Usage is keyed by `message.id` and only the largest observation per
id is kept. The same applies to `tool_use` blocks: dedupe by block id, or a
repeated chunk becomes a second invocation.

**Those per-message snapshots are still mid-generation.** On a real run,
deduping per-message usage reproduced input and cache tokens *exactly* against
the run's own terminal report — and showed 41 output tokens where the terminal
report said 2,411. The snapshot is taken before the message finishes. So the
terminal `result` line is authoritative when the run reached one; deduped
message usage is the fallback for runs killed before it; and which source was
used is recorded per run, with a warning when a usable run fell back, because
its output figure is then a lower bound rather than a measurement.

**Cost is reported as a list-price equivalent, and labelled as one.** It is
token counts multiplied by published list prices (or the agent's own list-price
total, which also covers auxiliary models the harness cannot price). It is not
what you were billed. Subscriptions, negotiated rates and plan-specific caching
make the real figure different. Saying "this cost $X" without that caveat is
the kind of number that gets quoted back at you.

## 7. Pilot before you measure, and know when N is too small

A scenario is only informative if the baseline leaves room to move:

- Baseline pass rate near 0% means the task is too hard. Nothing can improve it,
  so the tool cannot show an effect. **Floor.**
- Baseline pass rate near 100% means the task is too easy. The tool has no
  lever. **Ceiling.**
- Roughly **20%–80% baseline pass rate at N≈10** is the usable band.

Pilot every candidate scenario against that gate *before* it enters a suite, and
cut or redesign the ones that fail. Never "run it anyway" — a scenario that
fails the gate spends the full batch to tell you nothing. Piloting costs ~20
runs; skipping it costs ~80.

**The gate is a property of the scenario *and* the model, not the scenario
alone.** The bundled `greeting-locale` example sits at a 2/5 baseline on one
model and a 0/5 baseline — a floor — on another, with nothing about the scenario
changed. Re-pilot when you change the model you measure with; a scenario that
passed the gate a model ago is not evidence that it still does.

### The gate is inherited from model evals, and only half of it transfers

The 20–80% band comes from evaluating *difficulty*: a task everyone passes or
everyone fails cannot rank solvers. A tool eval asks a different question, and
the band transfers unevenly.

A pilot of ten scenarios against a real MCP server made this concrete: every
one came back a ceiling, 10/10 baseline, at N=10. Read strictly, the gate says
cut all ten. But a ceiling only kills the **efficacy** lever. Adoption, cost and
over-use stay perfectly measurable at a 100% baseline pass rate — "the agent
already solves this unaided; does it still reach for your tool, and what does
that cost?" is a real and often *more* useful question for a tool author than a
pass-rate delta.

The floor case is the mirror image. A floor is fatal only if the tool cannot
lift it either. A scenario at 0% baseline and 100% with the tool would be the
single most informative result a tool eval can produce — it is the gate's own
logic, applied to the wrong condition.

So gate **per metric**, not as one admit/reject:

| baseline | efficacy delta | adoption | cost delta | over-use |
| --- | --- | --- | --- | --- |
| floor (<20%) | usable *if the tool lifts it* — pilot the with-tool arm before cutting | usable | usable | n/a |
| valid (20–80%) | usable | usable | usable | n/a |
| ceiling (>80%) | dead — no headroom | usable | usable | usable |

`wasitused pilot` reports the verdict and exits non-zero outside the band
because that is the right default for an efficacy-led battery. It is a signal to
decide with, not an instruction to obey: a ceiling scenario kept deliberately as
a cost-and-adoption probe is a legitimate choice, and the reason should be
written down next to it.

Scenarios marked `toolRelevant: false` are exempt from the gate. Their job is to
count invocations where the tool cannot help, so a ceiling pass rate is expected
and fine.

On N: **N=5 is pilot scale.** It is enough to prove the loop runs and to gate a
scenario. It is not enough to publish, and this harness emits a warning saying
so on any batch below N=20. Citable numbers need **N=20–30 per condition**, and
null results need the high end — "we found no effect" at N=5 is indistinguishable
from "we did not look hard enough". Prefer fewer scenarios at high N over many at
thin N, and apply a multiplicity correction when comparing across many scenarios.

Every rate here carries a **Wilson score interval**, not a normal approximation.
At N=5, a normal interval around 5/5 collapses to zero width, which reads as
certainty the data does not contain. Wilson gives 5/5 a 95% interval of roughly
57%–100%, which is honest about what five runs can tell you. Means (tokens,
turns, wall clock, cost) carry a **Student *t*** interval for the same reason:
at n=5 the normal approximation is about 30% too narrow, and a too-narrow
interval is precisely what makes a pilot look conclusive. An interval is never
reported for n=1 — there is no spread in one observation to report.

`wasitused pilot` applies this gate directly. It runs the baseline arm only and
exits 0 for valid, 3 for floor, 4 for ceiling, and 5 for indeterminate, so a
scenario battery can be gated in a script rather than by eye. **Indeterminate is
a distinct outcome from floor**, deliberately: a scenario whose success check
never returned a determinate answer has not been measured at all, and recording
that as "too hard" would manufacture a finding out of a broken check — and would
cut a scenario that may be perfectly good.

## 8. The budget is an input, not a discovery

A full battery is hundreds of runs. "How much did that cost?" is a question you
want answered before the runs, not after, so the cap is a first-class argument
to a suite rather than something you watch and hope about.

Enforcing it at only one granularity leaks in one of two directions:

- **Per run only:** the cap holds, but scenarios get cut off halfway. Half a
  scenario is not a cheaper scenario, it is an unusable one — you paid for runs
  that cannot be compared against anything.
- **Per scenario only:** whole scenarios are clean, but a single runaway one
  blows the cap before anyone checks.

So both: the running total is checked after every finished run, *and* the next
scenario's cost is projected from what runs have cost so far, with a scenario
that cannot be afforded in full skipped rather than started. With no runs yet
there is nothing to project from, so the first scenario always starts and the
per-run guard is what protects the cap.

The reporting rule matters as much as the enforcement. A suite that quietly runs
six of ten scenarios and reports as if it ran ten is worse than one that refuses
to start: the numbers look complete. So every scenario appears in the output with
a status — completed, budget-stopped, skipped-budget, aborted-duds, failed — the
summary says out loud that the sweep is partial, and the command exits non-zero
when it did not cover what it was asked to cover.

Spend accounting includes runs that turned out to be unusable. Excluding duds
from *metrics* is correct; excluding them from *spend* would be lying about the
bill. A dud costs nothing by definition, but a run whose transcript broke
half-way still burned everything it burned before that.

## 9. The baseline must actually be a baseline

If the spawned agent inherits the host's config directory, environment or
working tree, then every "baseline" run silently includes whatever skills,
`CLAUDE.md` and memory the operator happens to have on their machine. The
output looks completely normal.

Each run therefore gets a throwaway config directory, a stripped environment
(with the stripped variable names recorded), and a fresh fixture copy in a temp
directory outside the harness's own repository. The conditions are interleaved
(with, without, with, without) rather than run in blocks, so drift over a batch
— rate limits, routing changes, a token approaching expiry — lands on both
conditions instead of loading onto whichever ran last.

As a backstop, the metrics pass checks for invocations in the *baseline*
condition and flags the batch as an isolation leak if it finds any. The baseline
has no access to the tool; if it called it, something in the toggle or the
matchers is wrong and no number from that batch should be trusted.

## 10. Metrics must be recomputable from stored artifacts

Transcripts are the source of truth. Metrics are a separate pass over the files
a batch left on disk — no agent process is involved, and `wasitused report` on
an old batch reproduces its numbers exactly.

This is not just tidiness. It means you can fix how something is measured and
re-derive every past result without re-running anything. That happened during
this project's own first real batch: the transcript parser was wrong about
output tokens, and correcting it re-costed ten completed runs at zero
additional cost. A metric you can only obtain by re-running the batch is a
metric you cannot audit, and one you will be reluctant to correct.

The scenario config is snapshotted into `batch.json` for the same reason. Edit
or delete the scenario file afterwards and the batch still recomputes, using the
matchers that were actually in force when it ran.

## 11. Documented robustness does not transfer

Everything above can be true, written down, and still absent from your code.
A lesson learned on one implementation does not carry over to a rewrite just
because it is in a design document.

So each item here has a test that *deliberately causes* the failure and asserts
the harness handles it: a simulated dead credential producing exit-0 zero-cost
runs, a transcript truncated mid-write, a transcript with streaming-duplicated
usage and a known correct total, a check that returns indeterminate, a config
with a misspelled matcher key, an isolation toggle that leaks into the baseline,
a budget that runs out mid-suite, a scenario that cannot be afforded in full, a
pass rate sitting exactly on each edge of the gate, a dud that would otherwise
drag a scenario into the floor, and an unmeasurable pass rate that must come out
indeterminate rather than floor.

If you fork this or write your own, re-earn them the same way. The tests are the
part that transfers.
