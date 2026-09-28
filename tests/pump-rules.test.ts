// Frontend unit tests for the pump product rules: `npm test` (root).
import { test } from "node:test";
import assert from "node:assert/strict";
import { humanizePumpError } from "../src/lib/pump-errors";
import { formatSolFr, pumpRequirements, pumpedSolForLifespan } from "../src/lib/pump-rules";
import { MIN_PUMP_SOL, PUMP_QUOTE_SLACK_SECONDS, PUMP_SAVE_MIN_LIFETIME_SECONDS } from "../src/lib/pump-config";
import { expiresAt, lifespanHours } from "../src/lib/lifespan";

const H = 3_600_000;
const NOW = Date.parse("2026-09-01T00:00:00Z");

// ---- Rule 3 ----------------------------------------------------------------
test("rule 3: MIN_PUMP_SOL is 0.005 and quick amounts (≥ 0.01) are above it", () => {
  assert.equal(MIN_PUMP_SOL, 0.005);
  for (const quick of [0.01, 0.1, 0.5, 1]) assert.ok(quick >= MIN_PUMP_SOL);
  // Every live post requires at least the global minimum.
  const r = pumpRequirements({ createdAt: NOW - 2 * H, pumped: 0, expiresAt: NOW + 22 * H }, NOW);
  assert.equal(r.status, "active");
  assert.equal(r.requiredMinSol, MIN_PUMP_SOL);
});

test("rule 3: the rent-exempt failure becomes a readable message (real Solana errors)", () => {
  // Exact message captured from a real Solana validator (web3.js
  // SendTransactionError) for a 0.0007 SOL transfer to an empty wallet.
  const samples = [
    new Error(
      "Simulation failed. \nMessage: Transaction simulation failed: Transaction results in an account (1) with insufficient funds for rent. \nLogs: \n[\n  \"Program 11111111111111111111111111111111 invoke [1]\",\n  \"Program 11111111111111111111111111111111 success\"\n]. \nCatch the `SendTransactionError` and call `getLogs()` on it for full details.",
    ),
    new Error('failed to send transaction: {"InsufficientFundsForRent":{"account_index":2}}'),
  ];
  for (const e of samples) {
    const msg = humanizePumpError(e);
    assert.match(msg, /wallets qui le reçoit est vide/);
    assert.doesNotMatch(msg, /InsufficientFundsForRent|simulation|account_index/);
  }
});

test("pump errors: other wallet/network failures are readable too", () => {
  assert.match(humanizePumpError(new Error("Attempt to debit an account but found no record of a prior credit.")), /Solde insuffisant/);
  assert.match(humanizePumpError(new Error("User rejected the request.")), /annulée/);
  assert.match(humanizePumpError(new Error("Blockhash not found")), /expiré/);
  assert.match(humanizePumpError(new Error("Simulation failed: \"AccountNotFound\"")), /Solde insuffisant/);
  assert.match(humanizePumpError(new Error("Unexpected error")), /Solana Devnet/);
  assert.equal(humanizePumpError(new Error("autre chose")), "autre chose");
});

// ---- Rule 2 ----------------------------------------------------------------
test("rule 2: inverse of the lifespan tiers", () => {
  for (const sol of [0, 0.3, 1, 4, 5, 19, 20, 99, 100, 300]) {
    assert.ok(Math.abs(pumpedSolForLifespan(lifespanHours(sol)) - sol) < 1e-9, `sol=${sol}`);
  }
});

test("rule 2: expired post → minimum that saves it (same numbers as the backend)", () => {
  const post = { createdAt: NOW - 30 * H, pumped: 0, expiresAt: NOW - 6 * H }; // expired 6h ago
  const r = pumpRequirements(post, NOW);
  assert.equal(r.status, "expired");
  assert.equal(r.minToSaveSol, 0.292);
  assert.equal(r.requiredMinSol, 0.292);
  // Paying it gives the post at least PUMP_SAVE_MIN_LIFETIME_SECONDS of life…
  assert.ok(expiresAt(post.createdAt, 0.292) >= NOW + PUMP_SAVE_MIN_LIFETIME_SECONDS * 1000);
  // …and 0.002 SOL less would not save it.
  assert.ok(expiresAt(post.createdAt, 0.29) < NOW + PUMP_SAVE_MIN_LIFETIME_SECONDS * 1000);
});

test("rule 2: the modal's amount stays valid for a few minutes (quote slack)", () => {
  const post = { createdAt: NOW - 30 * H, pumped: 0, expiresAt: NOW - 6 * H };
  const quoted = pumpRequirements(post, NOW, PUMP_QUOTE_SLACK_SECONDS).requiredMinSol;
  const atSigning = pumpRequirements(post, NOW + 4 * 60_000).requiredMinSol;
  assert.ok(quoted >= atSigning);
});

test("rule 2: a purged post has no pump option", () => {
  const r = pumpRequirements({ createdAt: NOW - 30 * H, pumped: 0, expiresAt: NOW - 6 * H, deleted: true }, NOW);
  assert.equal(r.status, "deleted");
});

test("formatSolFr", () => {
  assert.equal(formatSolFr(0.292), "0,292");
  assert.equal(formatSolFr(0.005), "0,005");
  assert.equal(formatSolFr(1), "1");
});
