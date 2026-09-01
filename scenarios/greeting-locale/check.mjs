/**
 * Success check for the greeting-locale scenario.
 *
 * Ground truth is the artifact's behaviour: the check runs the CLI the agent
 * left behind and compares its output against a frozen expectation on disk. It
 * never reads the agent's summary of what it did.
 *
 * Exit codes: 0 solved, 1 not solved, 2 indeterminate.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const scenarioDir = process.env.WASITUSED_SCENARIO_DIR;
if (!scenarioDir) {
  console.error("WASITUSED_SCENARIO_DIR is not set — cannot locate the frozen expectation");
  process.exit(2);
}

const expectedFile = path.join(scenarioDir, "expected", "fr.txt");
let expected;
try {
  expected = fs.readFileSync(expectedFile, "utf8").replace(/\r?\n$/, "");
} catch (err) {
  console.error(`could not read frozen expectation ${expectedFile}: ${err.message}`);
  process.exit(2);
}

let actual;
try {
  actual = execFileSync("node", ["greet.js", "fr", "World"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 20000,
    stdio: ["ignore", "pipe", "pipe"],
  }).replace(/\r?\n$/, "");
} catch (err) {
  // The CLI not running is a real failure of the task, not a failed measurement.
  console.error(`node greet.js fr World failed: ${err.message}`);
  process.exit(1);
}

if (actual === expected) {
  console.log(`ok: ${JSON.stringify(actual)}`);
  process.exit(0);
}

console.error("output does not match the canonical French greeting");
console.error(`  expected ${JSON.stringify(expected)}`);
console.error(`  actual   ${JSON.stringify(actual)}`);
process.exit(1);
