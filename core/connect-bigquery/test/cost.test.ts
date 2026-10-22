import { test } from "node:test";
import assert from "node:assert/strict";
import { capGbFromDollars, sayBytes, sayCap, sayCost, sayUsd, setupReadEstimate } from "../src/cost.js";

test("bytes and dollars are said the way a person weighs them", () => {
  assert.equal(sayBytes(500), "under 1 MB");
  assert.equal(sayBytes(250e6), "250 MB");
  assert.equal(sayBytes(1.74e9), "1.7 GB");
  assert.equal(sayBytes(35e9), "35 GB");
  assert.equal(sayUsd(1e6), "under a cent");
  assert.equal(sayUsd(2 ** 40), "about $6.25", "one tebibyte at list price");
  assert.equal(sayUsd(0.2 * 2 ** 40), "about $1.25");
  assert.equal(sayUsd(0.01 * 2 ** 40), "about 6 cents");
  assert.equal(sayCost(1.74e9), "1.7 GB, about 1 cent");
});

test("a limit set in dollars is turned into GB and read back in both", () => {
  const gb = capGbFromDollars(1);
  assert.equal(gb, 175.9, "$1 at $6.25 per TiB is 0.16 TiB, 175.9 GB");
  assert.match(sayCap(gb), /up to 176 GB \(about \$1\.00 at most\)/);
  assert.match(sayCap(5, "default"), /standard limit; you can change it/);
  assert.match(sayCap(0), /no limit/);
  assert.throws(() => capGbFromDollars(0), /more than zero/);
  assert.throws(() => capGbFromDollars(-3), /more than zero/);
});

test("looking at the data asks first only when it could read more than a gigabyte, using the smaller of the tables and the setup budget", () => {
  const small = setupReadEstimate([200e6, 300e6], 5e9);
  assert.equal(small.needs_go_ahead, false);
  assert.match(small.say, /at most 500 MB/);
  const big = setupReadEstimate([40e9, 2e9], 5e9);
  assert.equal(big.needs_go_ahead, true);
  assert.equal(big.at_most_bytes, 5e9, "capped by the setup budget: big tables are sampled");
  assert.match(big.say, /go-ahead/);
  const unknown = setupReadEstimate([undefined, 100e6], 5e9);
  assert.match(unknown.say, /some sizes are not known/);
  assert.equal(setupReadEstimate([], null).needs_go_ahead, false);
});
