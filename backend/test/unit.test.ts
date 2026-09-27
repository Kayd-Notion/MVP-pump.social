// Unit tests for pure logic: `npm test` (no Docker needed).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET ??= "unit-test-secret-unit-test-secret-0123";
process.env.PLATFORM_WALLET ??= "4QmGx5cAVfuSdEpZgwmwv6J5SJbWYguphDAv8a6Jn22r";
process.env.S3_ACCESS_KEY ??= "x";
process.env.S3_SECRET_KEY ??= "x";
process.env.PGHOST ??= "localhost";

const { solToLamports, lamportsToSol } = await import("../src/lib/money.js");
const { splitLamports } = await import("../src/lib/split.js");
const { lifespanHours } = await import("../src/lib/lifespan.js");
const { verifyPumpTransaction } = await import("../src/lib/solana.js");

test("SOL ↔ lamports is exact", () => {
  assert.equal(solToLamports("0.1"), 100_000_000n);
  assert.equal(solToLamports(0.1), 100_000_000n);
  assert.equal(solToLamports(1.5), 1_500_000_000n);
  assert.equal(solToLamports("0.000000001"), 1n);
  assert.equal(lamportsToSol(1_600_000_000n), "1.600000000");
  assert.throws(() => solToLamports("0.0000000001")); // > 9 decimals
  assert.throws(() => solToLamports("-1"));
  assert.throws(() => solToLamports("1e3"));
});

test("split floors the platform share, parts always sum to the total", () => {
  assert.deepEqual(splitLamports(100_000_000n, 3000), { creator: 70_000_000n, platform: 30_000_000n });
  assert.deepEqual(splitLamports(7n, 3000), { creator: 5n, platform: 2n });
  for (const t of [1n, 3n, 999_999_999n]) {
    const s = splitLamports(t, 3000);
    assert.equal(s.creator + s.platform, t);
  }
});

test("lifespan tiers: 24h base, no cap", () => {
  assert.equal(lifespanHours(0), 24);
  assert.equal(lifespanHours(0.1), 26.4);
  assert.equal(lifespanHours(1.6), 55.2);
  assert.equal(lifespanHours(200), 24 + 24 + 48 + 90 + 240 + 150);
});

const PAYER = "3X5VWfJ2TMzefZiMzAwW7X2FP6iRB8gf1F5Koor1jD2h";
const CREATOR = "6U9jAqQEDnLiooHcqpCBGHbuKMTf26LjbXYNeKrtDY2W";
const PLATFORM = "4QmGx5cAVfuSdEpZgwmwv6J5SJbWYguphDAv8a6Jn22r";
const NOW = 1_800_000_000_000;

function tx(transfers: [string, number][], opts: { blockTime?: number | null; signer?: string; err?: unknown } = {}) {
  return {
    blockTime: opts.blockTime === undefined ? NOW / 1000 - 5 : opts.blockTime,
    meta: { err: opts.err ?? null },
    transaction: {
      signatures: ["sig"],
      message: {
        accountKeys: [{ pubkey: opts.signer ?? PAYER, signer: true, writable: true }],
        instructions: transfers.map(([destination, lamports]) => ({
          program: "system",
          programId: "11111111111111111111111111111111",
          parsed: { type: "transfer", info: { source: PAYER, destination, lamports } },
        })),
      },
    },
  };
}
const exp = (over: Partial<Parameters<typeof verifyPumpTransaction>[1]> = {}) => ({
  payer: PAYER,
  creatorWallet: CREATOR,
  platformWallet: PLATFORM,
  declaredLamports: 100_000_000n,
  platformBps: 3000,
  maxAgeSeconds: 900,
  now: NOW,
  ...over,
});
const code = (fn: () => unknown) => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return (e as { code: string }).code;
  }
};

test("verifyPumpTransaction: accepts the exact 70/30 pump", () => {
  const v = verifyPumpTransaction(tx([[CREATOR, 70_000_000], [PLATFORM, 30_000_000]]), exp());
  assert.equal(v.creatorLamports, 70_000_000n);
  assert.equal(v.platformLamports, 30_000_000n);
});

test("verifyPumpTransaction: rejections", () => {
  const good: [string, number][] = [[CREATOR, 70_000_000], [PLATFORM, 30_000_000]];
  assert.equal(code(() => verifyPumpTransaction(null, exp())), "tx_not_found");
  assert.equal(code(() => verifyPumpTransaction(tx(good, { err: { x: 1 } }), exp())), "tx_failed");
  assert.equal(code(() => verifyPumpTransaction(tx(good, { blockTime: NOW / 1000 - 3600 }), exp())), "tx_too_old");
  assert.equal(code(() => verifyPumpTransaction(tx(good, { signer: CREATOR }), exp())), "wrong_sender");
  assert.equal(code(() => verifyPumpTransaction(tx(good), exp({ declaredLamports: 1n }))), "amount_mismatch");
  assert.equal(code(() => verifyPumpTransaction(tx([[CREATOR, 50_000_000], [PLATFORM, 50_000_000]]), exp())), "split_mismatch");
  assert.equal(code(() => verifyPumpTransaction(tx([...good, [PAYER.replace("3", "4"), 1]]), exp())), "unexpected_transfer");
  assert.equal(code(() => verifyPumpTransaction(tx([]), exp())), "no_transfer");
});

test("verifyPumpTransaction: blockTime null (very recent) is accepted", () => {
  assert.equal(code(() => verifyPumpTransaction(tx([[CREATOR, 70_000_000], [PLATFORM, 30_000_000]], { blockTime: null }), exp())), "ok");
});

test("verifyPumpTransaction: creator == platform wallet (both shares to one address)", () => {
  const v = verifyPumpTransaction(tx([[PLATFORM, 70_000_000], [PLATFORM, 30_000_000]]), exp({ creatorWallet: PLATFORM }));
  assert.equal(v.creatorLamports + v.platformLamports, 100_000_000n);
});
