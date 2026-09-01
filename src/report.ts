/**
 * Self-contained HTML report. No build step, no CDN, no client-side JS —
 * a report you can email to someone or open five years from now.
 */

import type {
  BatchMetrics,
  ConditionMetrics,
  CostComparison,
  RunMetrics,
} from "./metrics";
import type { Rate, Summary } from "./stats";

function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(0)}%`;
}

function signedPct(value: number | null): string {
  if (value === null) return "n/a";
  const s = `${(value * 100).toFixed(0)}pp`;
  return value > 0 ? `+${s}` : s;
}

function num(value: number | null, digits = 1): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

function signedNum(value: number | null, digits = 1): string {
  if (value === null) return "n/a";
  const s = value.toFixed(digits);
  return value > 0 ? `+${s}` : s;
}

function rateCell(r: Rate): string {
  if (r.rate === null) return `<span class="na">n/a (0 runs)</span>`;
  const ci = r.ci95
    ? `<span class="ci">95% CI ${pct(r.ci95[0])}–${pct(r.ci95[1])}</span>`
    : "";
  return `<strong>${pct(r.rate)}</strong> <span class="frac">${r.k}/${r.n}</span> ${ci}`;
}

function summaryCell(s: Summary, digits = 1): string {
  if (s.mean === null) return `<span class="na">n/a</span>`;
  const sd = s.sd === null ? "sd n/a (n=1)" : `sd ${num(s.sd, digits)}`;
  return `<strong>${num(s.mean, digits)}</strong> <span class="ci">${sd}, n=${s.n}</span>`;
}

function conditionTable(m: BatchMetrics): string {
  const row = (label: string, get: (c: ConditionMetrics) => string) =>
    `<tr><th>${label}</th><td>${get(m.conditions.with_tool)}</td><td>${get(
      m.conditions.baseline
    )}</td></tr>`;

  return `
<table class="grid">
  <thead><tr><th></th><th>with tool</th><th>baseline (no tool)</th></tr></thead>
  <tbody>
    ${row("Runs attempted", (c) => String(c.runsAttempted))}
    ${row(
      "Excluded as unusable",
      (c) =>
        `${
          c.excluded.dudZeroCost +
          c.excluded.unparseableTranscript +
          c.excluded.missingRunRecord
        } <span class="ci">${c.excluded.dudZeroCost} zero-cost, ${
          c.excluded.unparseableTranscript
        } unparseable, ${c.excluded.missingRunRecord} missing</span>`
    )}
    ${row("Usable runs", (c) => String(c.usable))}
    ${row("Adoption — tool actually invoked", (c) => rateCell(c.adoption))}
    ${row("Read the docs but never called it", (c) => rateCell(c.documentationOnly))}
    ${row(
      "Pass rate (solved / determinate)",
      (c) =>
        `${rateCell(c.efficacy.passRate)}${
          c.efficacy.indeterminate > 0
            ? `<div class="warnlet">${c.efficacy.indeterminate} run(s) indeterminate (solved = null), excluded from the rate</div>`
            : ""
        }`
    )}
    ${row("Total tokens", (c) => summaryCell(c.cost.totalTokens, 0))}
    ${row("Turns", (c) => summaryCell(c.cost.turns, 1))}
    ${row("Wall clock (s)", (c) => summaryCell({ ...c.cost.wallClockMs, mean: c.cost.wallClockMs.mean === null ? null : c.cost.wallClockMs.mean / 1000, sd: c.cost.wallClockMs.sd === null ? null : c.cost.wallClockMs.sd / 1000 }, 1))}
    ${row("USD (list-price equivalent)", (c) => summaryCell(c.cost.usdListEquivalent, 4))}
  </tbody>
</table>`;
}

function costTable(rows: CostComparison[]): string {
  return `
<table class="grid">
  <thead>
    <tr>
      <th>metric</th><th>baseline</th><th>with tool (all)</th>
      <th>with tool (invoked only)</th><th>&Delta; all</th><th>&Delta; invoked only</th>
    </tr>
  </thead>
  <tbody>
    ${rows
      .map((r) => {
        const digits = r.metric.startsWith("USD") ? 4 : r.metric === "turns" ? 1 : 0;
        return `<tr>
      <th>${esc(r.metric)}</th>
      <td>${summaryCell(r.baseline, digits)}</td>
      <td>${summaryCell(r.withToolAll, digits)}</td>
      <td>${summaryCell(r.withToolInvoked, digits)}</td>
      <td>${signedNum(r.deltaAllRuns, digits)}</td>
      <td>${signedNum(r.deltaInvokedOnly, digits)}</td>
    </tr>`;
      })
      .join("\n")}
  </tbody>
</table>`;
}

function runTable(runs: RunMetrics[]): string {
  return `
<table class="grid runs">
  <thead>
    <tr>
      <th>run</th><th>condition</th><th>invoked</th><th>docs read</th>
      <th>solved</th><th>turns</th><th>tokens</th><th>USD (list eq.)</th>
      <th>wall clock</th><th>status</th>
    </tr>
  </thead>
  <tbody>
    ${runs
      .map((r) => {
        const solved =
          r.solved === true
            ? `<span class="ok">yes</span>`
            : r.solved === false
              ? `<span class="bad">no</span>`
              : `<span class="null">null</span>`;
        const status = r.usable
          ? r.transcriptComplete
            ? `<span class="ok">ok</span>`
            : `<span class="warn">incomplete transcript</span>`
          : `<span class="bad">excluded: ${esc(r.exclusion)}</span>`;
        return `<tr class="${r.usable ? "" : "excluded"}">
      <td><code>${esc(r.runId)}</code></td>
      <td>${esc(r.condition)}</td>
      <td>${r.invoked ? `yes (${r.invocationCount})` : "no"}</td>
      <td>${r.documentationCount > 0 ? `yes (${r.documentationCount})` : "no"}</td>
      <td>${solved}</td>
      <td>${r.turns}</td>
      <td>${r.tokens.total.toLocaleString("en-US")}</td>
      <td>${r.usdListEquivalent === null ? "n/a" : r.usdListEquivalent.toFixed(4)}</td>
      <td>${(r.wallClockMs / 1000).toFixed(1)}s</td>
      <td>${status}${
        r.exclusionReason ? `<div class="warnlet">${esc(r.exclusionReason)}</div>` : ""
      }</td>
    </tr>`;
      })
      .join("\n")}
  </tbody>
</table>`;
}

export function renderReport(m: BatchMetrics): string {
  const e = m.efficacy;
  const c = e.invocationCounts;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>wasitused — ${esc(m.scenarioId)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         margin: 0 auto; max-width: 1080px; padding: 2rem 1.25rem 5rem; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.1rem; margin: 2.25rem 0 .6rem; padding-bottom: .3rem; border-bottom: 1px solid #8883; }
  .sub { color: #7a7a7a; margin: 0 0 1.5rem; }
  .meta { display: flex; flex-wrap: wrap; gap: .5rem 1.25rem; font-size: .85rem; color: #7a7a7a; margin-bottom: 1.5rem; }
  .meta code { color: inherit; }
  table.grid { border-collapse: collapse; width: 100%; font-size: .88rem; }
  table.grid th, table.grid td { border: 1px solid #8883; padding: .45rem .6rem; text-align: left; vertical-align: top; }
  table.grid thead th { background: #8881; font-weight: 600; }
  table.grid tbody th { background: #8880; font-weight: 500; width: 30%; }
  .runs td, .runs th { font-size: .82rem; }
  .runs tr.excluded { opacity: .62; }
  .ci, .frac { color: #7a7a7a; font-size: .82em; }
  .na, .null { color: #9a7a2a; font-style: italic; }
  .ok { color: #2e7d32; } .bad { color: #c62828; } .warn { color: #ef6c00; }
  .warnlet { color: #ef6c00; font-size: .78rem; margin-top: .2rem; }
  .callout { border-left: 4px solid #ef6c00; background: #ef6c0014; padding: .7rem .9rem; margin: .6rem 0; border-radius: 0 4px 4px 0; }
  .callout.critical { border-color: #c62828; background: #c6282814; }
  .callout ul { margin: .3rem 0 0; padding-left: 1.1rem; }
  .caveat { font-size: .82rem; color: #7a7a7a; border-left: 3px solid #8884; padding-left: .8rem; margin: .8rem 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
  footer { margin-top: 3rem; font-size: .8rem; color: #7a7a7a; }
</style>
</head>
<body>

<h1>${esc(m.scenarioId)} <span style="font-weight:400;color:#7a7a7a">&mdash; ${esc(
    m.toolName
  )}</span></h1>
<p class="sub">Did the agent actually use the tool, and did using it help?</p>

<div class="meta">
  <span>batch <code>${esc(m.batchId)}</code></span>
  <span>model <code>${esc(m.model)}</code></span>
  <span>N=${m.n} per condition</span>
  <span>${m.toolRelevant ? "tool-relevant scenario" : "tool-IRRELEVANT scenario (over-use probe)"}</span>
  <span>generated ${esc(m.generatedAt)}</span>
</div>

${
  m.aborted
    ? `<div class="callout critical"><strong>Batch aborted.</strong> ${esc(
        m.abortReason ?? ""
      )}</div>`
    : ""
}
${
  m.warnings.length > 0
    ? `<div class="callout"><strong>Read before quoting any number here</strong><ul>${m.warnings
        .map((w) => `<li>${esc(w)}</li>`)
        .join("")}</ul></div>`
    : ""
}

<h2>Adoption</h2>
<p>Adoption counts <em>actual tool calls found in the transcript</em>. Reading the
tool's documentation is tracked separately and never counts as adoption.</p>
${conditionTable(m)}

<h2>Efficacy</h2>
<p>${esc(e.note)}</p>
<table class="grid">
  <thead><tr><th>slice</th><th>pass rate</th><th>&Delta; vs baseline</th></tr></thead>
  <tbody>
    <tr><th>baseline (no tool)</th><td>${rateCell(e.baseline)}</td><td>&mdash;</td></tr>
    <tr><th>with tool — all usable runs</th><td>${rateCell(
      e.withToolAll
    )}</td><td>${signedPct(e.deltaAllRuns)}</td></tr>
    <tr><th>with tool — invoked only <span class="ci">(${c.withToolInvoked}/${
      c.withToolUsable
    } runs)</span></th><td>${rateCell(e.withToolInvoked)}</td><td>${signedPct(
      e.deltaInvokedOnly
    )}</td></tr>
    <tr><th>with tool — never invoked <span class="ci">(${
      c.withToolUsable - c.withToolInvoked
    }/${c.withToolUsable} runs)</span></th><td>${rateCell(
      e.withToolNotInvoked
    )}</td><td>&mdash;</td></tr>
  </tbody>
</table>
<p class="caveat">The "all usable runs" delta mixes runs where the tool ran with runs
where it did not. Only the invoked-only row is attributable to the tool. Both are shown
so the gap between them stays visible.</p>

<h2>Cost</h2>
${costTable(m.cost)}
<p class="caveat">${esc(m.costCaveat)} Per-run figures prefer the run's own
list-price total where the agent reported one (which covers auxiliary models this
harness does not price); otherwise the token counts are multiplied by this harness's
per-model list prices. The <code>usdSource</code> field in <code>metrics.json</code>
records which was used for each run.</p>

<h2>Over-use</h2>
<p>${esc(m.overUse.note)}</p>
${
  m.overUse.applicable && m.overUse.rate
    ? `<table class="grid"><tbody><tr><th>Over-use rate (invocations where the tool cannot help)</th><td>${rateCell(
        m.overUse.rate
      )}</td></tr></tbody></table>`
    : ""
}

<h2>Runs</h2>
${runTable(m.runs)}

<footer>
Generated by <strong>wasitused</strong> ${esc(m.n)}&times;2 runs.
Every figure above was recomputed from the stored transcripts in this batch directory;
re-run <code>wasitused report</code> on it to reproduce this page without spending a run.
</footer>

</body>
</html>
`;
}
