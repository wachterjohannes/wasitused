import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseConditions } from "../src/cli";

test("no --conditions leaves the default pair alone", () => {
  assert.equal(parseConditions(undefined), undefined);
});

test("a single condition is accepted", () => {
  assert.deepEqual(parseConditions("with_tool"), ["with_tool"]);
  assert.deepEqual(parseConditions("baseline"), ["baseline"]);
});

test("both conditions may be named explicitly, in either order", () => {
  assert.deepEqual(parseConditions("with_tool,baseline"), ["with_tool", "baseline"]);
  assert.deepEqual(parseConditions("baseline,with_tool"), ["baseline", "with_tool"]);
});

test("whitespace around names is tolerated", () => {
  assert.deepEqual(parseConditions(" with_tool , baseline "), ["with_tool", "baseline"]);
});

test("a repeated condition is not run twice", () => {
  assert.deepEqual(parseConditions("with_tool,with_tool"), ["with_tool"]);
});

/**
 * A typo must not quietly select the other arm. Silently running baseline when
 * with_tool was meant produces a number that looks like a result.
 */
test("an unknown condition is rejected rather than ignored", () => {
  assert.throws(() => parseConditions("with-tool"), /unknown condition "with-tool"/);
  assert.throws(() => parseConditions("with_tool,typo"), /unknown condition "typo"/);
});

test("an empty list is rejected rather than treated as the default", () => {
  assert.throws(() => parseConditions(""), /named nothing/);
  assert.throws(() => parseConditions(" , "), /named nothing/);
});
