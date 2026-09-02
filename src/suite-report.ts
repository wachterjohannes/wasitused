/**
 * Self-contained HTML for a suite: one row per scenario, the pilot verdict when
 * there is one, and the budget accounting up front rather than in a footnote.
 */

import { formatRate, formatSummary, formatUsd, formatTokens, pct } from "./format";
import type { SuiteSummary } from "./suite";

function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const VERDICT_CLASS: Record<string, string> = {
  valid: "ok",
  floor: "bad",
  ceiling: "bad",
  indeterminate: "warn",
};

const STATUS_CLASS: Record<string, string> = {
  completed: "ok",
  "budget-stopped": "warn",
  "skipped-budget": "warn",
  "aborted-duds": "bad",
  failed: "bad",
};

function budgetBar(s: SuiteSummary): string {
  const rows: string[] = [];
  if (s.budget.maxUsd !== null) {
    const used = s.budget.maxUsd === 0 ? 1 : s.spend.usd / s.budget.maxUsd;
    rows.push(
      `<tr><th>USD (list-price equivalent)</th><td>${formatUsd(
        s.spend.usd
      )} of ${formatUsd(s.budget.maxUsd)} <span class="ci">(${pct(
        Math.min(used, 1)
      )})</span></td></tr>`
    );
  }
  if (s.budget.maxTokens !== null) {
    const used = s.budget.maxTokens === 0 ? 1 : s.spend.tokens / s.budget.maxTokens;
    rows.push(
      `<tr><th>Tokens</th><td>${formatTokens(s.spend.tokens)} of ${formatTokens(
        s.budget.maxTokens
      )} <span class="ci">(${pct(Math.min(used, 1))})</span></td></tr>`
    );
  }
  if (rows.length === 0) {
    rows.push(
      `<tr><th>Budget</th><td><span class="na">none set</span> — spent ${formatUsd(
        s.spend.usd
      )} / ${formatTokens(s.spend.tokens)} tokens over ${s.spend.runs} runs</td></tr>`
    );
  } else {
    rows.push(`<tr><th>Runs executed</th><td>${s.spend.runs}</td></tr>`);
  }
  return `<table class="grid">${rows.join("")}</table>`;
}

export function renderSuiteReport(s: SuiteSummary): string {
  const isPilot = s.mode === "pilot";

  const rows = s.scenarios
    .map((sc) => {
      const verdict = sc.verdict
        ? `<span class="${VERDICT_CLASS[sc.verdict] ?? ""}">${esc(sc.verdict)}</span>`
        : "&mdash;";
      const status = `<span class="${STATUS_CLASS[sc.status] ?? ""}">${esc(
        sc.status
      )}</span>`;
      return `<tr>
    <td><code>${esc(sc.scenarioId)}</code>${
      sc.toolRelevant === false
        ? '<div class="ci">tool-irrelevant (over-use probe, exempt from the gate)</div>'
        : ""
    }</td>
    <td>${status}${sc.reason ? `<div class="warnlet">${esc(sc.reason)}</div>` : ""}</td>
    ${isPilot ? `<td>${verdict}</td>` : ""}
    <td>${sc.baselinePassRate ? esc(formatRate(sc.baselinePassRate)) : "&mdash;"}</td>
    ${
      isPilot
        ? ""
        : `<td>${
            sc.withToolPassRate ? esc(formatRate(sc.withToolPassRate)) : "&mdash;"
          }</td><td>${sc.adoption ? esc(formatRate(sc.adoption)) : "&mdash;"}</td>`
    }
    <td>${sc.runsExecuted}/${sc.runsPlanned}${
      sc.usableRuns !== sc.runsExecuted
        ? `<div class="warnlet">${sc.usableRuns} usable</div>`
        : ""
    }</td>
    <td>${esc(formatSummary(sc.tokensPerRun, 0))}</td>
    <td>${formatUsd(sc.spend.usd)}</td>
  </tr>`;
    })
    .join("\n");

  const header = isPilot
    ? `<tr><th>scenario</th><th>status</th><th>verdict</th><th>baseline pass rate</th><th>runs</th><th>tokens/run</th><th>spend</th></tr>`
    : `<tr><th>scenario</th><th>status</th><th>baseline pass rate</th><th>with-tool pass rate</th><th>adoption</th><th>runs</th><th>tokens/run</th><th>spend</th></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>wasitused suite — ${esc(s.suiteId)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         margin: 0 auto; max-width: 1180px; padding: 2rem 1.25rem 5rem; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.1rem; margin: 2.25rem 0 .6rem; padding-bottom: .3rem; border-bottom: 1px solid #8883; }
  .sub { color: #7a7a7a; margin: 0 0 1.5rem; }
  .meta { display: flex; flex-wrap: wrap; gap: .5rem 1.25rem; font-size: .85rem; color: #7a7a7a; margin-bottom: 1.5rem; }
  table.grid { border-collapse: collapse; width: 100%; font-size: .85rem; }
  table.grid th, table.grid td { border: 1px solid #8883; padding: .45rem .6rem; text-align: left; vertical-align: top; }
  table.grid thead th { background: #8881; font-weight: 600; }
  table.grid tbody th { background: #8880; font-weight: 500; width: 32%; }
  .ci { color: #7a7a7a; font-size: .82em; }
  .na { color: #9a7a2a; font-style: italic; }
  .ok { color: #2e7d32; font-weight: 600; }
  .bad { color: #c62828; font-weight: 600; }
  .warn { color: #ef6c00; font-weight: 600; }
  .warnlet { color: #ef6c00; font-size: .78rem; margin-top: .2rem; }
  .callout { border-left: 4px solid #ef6c00; background: #ef6c0014; padding: .7rem .9rem; margin: .6rem 0; border-radius: 0 4px 4px 0; }
  .callout ul { margin: .3rem 0 0; padding-left: 1.1rem; }
  .caveat { font-size: .82rem; color: #7a7a7a; border-left: 3px solid #8884; padding-left: .8rem; margin: .8rem 0; }
  .tally { display: flex; flex-wrap: wrap; gap: 1.5rem; margin: .5rem 0 1rem; }
  .tally div { font-size: .85rem; }
  .tally strong { display: block; font-size: 1.5rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
  footer { margin-top: 3rem; font-size: .8rem; color: #7a7a7a; }
</style>
</head>
<body>

<h1>Suite ${esc(s.mode)} <span style="font-weight:400;color:#7a7a7a">&mdash; ${
    s.counts.total
  } scenarios</span></h1>
<p class="sub">${
    isPilot
      ? "Baseline only. Which scenarios have room for a tool to move the outcome?"
      : "With-tool vs. baseline across the suite."
  }</p>

<div class="meta">
  <span>suite <code>${esc(s.suiteId)}</code></span>
  <span>model <code>${esc(s.model ?? "per scenario")}</code></span>
  <span>N=${s.n}${isPilot ? " (baseline only)" : " per condition"}</span>
  <span>generated ${esc(s.generatedAt)}</span>
</div>

${
  s.warnings.length > 0
    ? `<div class="callout"><strong>Read before quoting any number here</strong><ul>${s.warnings
        .map((w) => `<li>${esc(w)}</li>`)
        .join("")}</ul></div>`
    : ""
}

<h2>Budget</h2>
${budgetBar(s)}
<p class="caveat">${esc(s.costCaveat)}</p>

<h2>${isPilot ? "Gate outcome" : "Outcome"}</h2>
<div class="tally">
  ${
    isPilot
      ? `<div><strong class="ok">${s.counts.valid}</strong>valid</div>
         <div><strong class="bad">${s.counts.floor}</strong>floor</div>
         <div><strong class="bad">${s.counts.ceiling}</strong>ceiling</div>
         <div><strong class="warn">${s.counts.indeterminate}</strong>indeterminate</div>`
      : ""
  }
  <div><strong>${s.counts.completed}</strong>completed</div>
  <div><strong class="warn">${s.counts.skippedBudget + s.counts.budgetStopped}</strong>budget-limited</div>
  <div><strong class="bad">${s.counts.abortedDuds + s.counts.failed}</strong>failed/aborted</div>
</div>

<table class="grid">
  <thead>${header}</thead>
  <tbody>
${rows}
  </tbody>
</table>

<footer>
Generated by <strong>wasitused</strong>. Every figure was recomputed from the stored
batches in this suite directory; re-run <code>wasitused suite-report</code> on it to
reproduce this page without spending a run.
</footer>

</body>
</html>
`;
}
