#!/usr/bin/env node
"use strict";
// Thin launcher. The real CLI lives in dist/src/cli.js (built with `npm run build`).
const path = require("node:path");
const fs = require("node:fs");

const compiled = path.join(__dirname, "..", "dist", "src", "cli.js");
if (!fs.existsSync(compiled)) {
  process.stderr.write(
    "wasitused: build output missing at " +
      compiled +
      "\nRun `npm install && npm run build` first.\n"
  );
  process.exit(1);
}
require(compiled).main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(String((err && err.stack) || err) + "\n");
  process.exit(1);
});
