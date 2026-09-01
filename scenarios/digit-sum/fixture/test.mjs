import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { sumDigits } = createRequire(import.meta.url)("./sum-digits.js");

const cases = [
  [123, 6],
  [0, 0],
  [-45, 9],
];

let failed = 0;
for (const [input, expected] of cases) {
  try {
    assert.equal(sumDigits(input), expected);
    console.log(`ok    sumDigits(${input}) === ${expected}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  sumDigits(${input}) === ${expected}  (got ${sumDigits(input)})`);
  }
}

process.exit(failed === 0 ? 0 : 1);
