/**
 * Success check for the digit-sum scenario.
 *
 * Runs the agent's implementation against frozen cases held outside the
 * fixture. The fixture ships its own visible test file so the task reads
 * naturally, but that file is not what grades the run — an agent that edits
 * the visible tests into passing still fails here.
 *
 * Exit codes: 0 solved, 1 not solved, 2 indeterminate.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const scenarioDir = process.env.WASITUSED_SCENARIO_DIR;
if (!scenarioDir) {
  console.error("WASITUSED_SCENARIO_DIR is not set — cannot locate the frozen cases");
  process.exit(2);
}

let cases;
try {
  cases = JSON.parse(
    fs.readFileSync(path.join(scenarioDir, "expected", "cases.json"), "utf8")
  );
} catch (err) {
  console.error(`could not read frozen cases: ${err.message}`);
  process.exit(2);
}

const require = createRequire(path.join(process.cwd(), "check.cjs"));
let sumDigits;
try {
  ({ sumDigits } = require(path.join(process.cwd(), "sum-digits.js")));
} catch (err) {
  console.error(`could not load sum-digits.js from the artifact: ${err.message}`);
  process.exit(1);
}

if (typeof sumDigits !== "function") {
  console.error("sum-digits.js no longer exports a sumDigits function");
  process.exit(1);
}

let failed = 0;
for (const [input, expected] of cases) {
  let actual;
  try {
    actual = sumDigits(input);
  } catch (err) {
    actual = `threw ${err.message}`;
  }
  if (actual === expected) {
    console.log(`ok    sumDigits(${input}) === ${expected}`);
  } else {
    failed++;
    console.error(`FAIL  sumDigits(${input}) expected ${expected}, got ${actual}`);
  }
}

process.exit(failed === 0 ? 0 : 1);
