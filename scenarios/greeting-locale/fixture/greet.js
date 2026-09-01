#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const [locale, name] = process.argv.slice(2);

if (!locale || !name) {
  console.error("usage: node greet.js <locale> <name>");
  process.exit(2);
}

const file = path.join(__dirname, "locales", `${locale}.json`);
if (!fs.existsSync(file)) {
  console.error(`unsupported locale: ${locale}`);
  process.exit(1);
}

const { template } = JSON.parse(fs.readFileSync(file, "utf8"));
console.log(template.replace("{name}", name));
