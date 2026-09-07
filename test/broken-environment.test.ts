import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isBrokenEnvironment } from "../src/metrics";

test("a healthy run is not excluded", () => {
  assert.equal(isBrokenEnvironment({ shellCalls: 20, shellSilentFailures: 0 }), false);
});

/**
 * Empty output is ordinary in small numbers: grep with no match, a failing
 * test, a command whose only effect is its exit status.
 */
test("a few empty results are ordinary and do not exclude the run", () => {
  assert.equal(isBrokenEnvironment({ shellCalls: 20, shellSilentFailures: 3 }), false);
  assert.equal(isBrokenEnvironment({ shellCalls: 20, shellSilentFailures: 10 }), false);
});

test("a majority of silent failures means the host failed, not the agent", () => {
  assert.equal(isBrokenEnvironment({ shellCalls: 20, shellSilentFailures: 11 }), true);
  assert.equal(isBrokenEnvironment({ shellCalls: 32, shellSilentFailures: 26 }), true);
});

/**
 * A run that barely used the shell has too little evidence either way, and
 * excluding it would throw away a legitimate result.
 */
test("too few shell calls to judge leaves the run usable", () => {
  assert.equal(isBrokenEnvironment({ shellCalls: 4, shellSilentFailures: 4 }), false);
  assert.equal(isBrokenEnvironment({ shellCalls: 0, shellSilentFailures: 0 }), false);
});

test("the boundary is exclusive, so exactly half does not exclude", () => {
  assert.equal(isBrokenEnvironment({ shellCalls: 10, shellSilentFailures: 5 }), false);
  assert.equal(isBrokenEnvironment({ shellCalls: 10, shellSilentFailures: 6 }), true);
});

import { isSilentShellResult } from "../src/transcript";

test("real output is not a silent failure", () => {
  assert.equal(isSilentShellResult("Report1.php\nReport2.php"), false);
  assert.equal(isSilentShellResult("Exit code 1\nvendor/rector/... some real output"), false);
});

/**
 * The shapes a broken host produces: nothing at all, the harness's marker, or
 * an exit status with no accompanying output.
 */
test("output-free results are recognised whatever shape they arrive in", () => {
  assert.equal(isSilentShellResult(""), true);
  assert.equal(isSilentShellResult("   \n  "), true);
  assert.equal(isSilentShellResult("(Bash completed with no output)"), true);
  assert.equal(isSilentShellResult("Exit code 1"), true);
  assert.equal(isSilentShellResult("Exit code 123"), true);
});
