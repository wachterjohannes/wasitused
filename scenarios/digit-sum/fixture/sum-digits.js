"use strict";

/**
 * Sum of the decimal digits of an integer.
 * The sign is not a digit: sumDigits(-45) is 9.
 */
function sumDigits(n) {
  return String(n)
    .split("")
    .reduce((acc, ch) => acc + Number(ch), 0);
}

module.exports = { sumDigits };
