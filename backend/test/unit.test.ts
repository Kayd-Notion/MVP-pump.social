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

// ---------------------------------------------------------------------------
// Pump product rules (lib/pump-rules.ts)
// ---------------------------------------------------------------------------
const { pumpedSolForLifespan, pumpRequirements, assertPumpAllowed, assertAboveMinPump, formatSolFr } =
  await import("../src/lib/pump-rules.js");
const { expiresAt } = await import("../src/lib/lifespan.js");
const { config } = await import("../src/config.js");

const H = 3_600_000;
const T0 = new Date("2026-09-01T00:00:00Z");
const post = (o: { ageH: number; lifeH?: number; pumped?: number; deleted?: boolean }) => ({
  created_at: new Date(T0.getTime() - o.ageH * H),
  duration_expires_at: new Date(T0.getTime() - o.ageH * H + (o.lifeH ?? 24) * H),
  deleted_at: o.deleted ? T0 : null,
  total_pumped_sol: String(o.pumped ?? 0),
});

test("rule 2: pumpedSolForLifespan is the exact inverse of the tiers", () => {
  for (const sol of [0, 0.5, 1, 3, 5, 12.5, 20, 60, 100, 250]) {
    assert.ok(Math.abs(pumpedSolForLifespan(lifespanHours(sol)) - sol) < 1e-9, `sol=${sol}`);
  }
  assert.equal(pumpedSolForLifespan(10), 0); // below the 24h base
});

test("rule 3: MIN_PUMP_SOL defaults to 0.005 and is enforced", () => {
  assert.equal(config.pump.minPumpLamports, 5_000_000n);
  assert.equal(code(() => assertAboveMinPump(4_999_999n)), "below_min_pump");
  assert.equal(code(() => assertAboveMinPump(5_000_000n)), "ok");
  // quick amounts (0.01 and up) are never affected
  assert.equal(code(() => assertAboveMinPump(10_000_000n)), "ok");
});

test("rule 2: active post → only the global minimum applies", () => {
  const r = pumpRequirements(post({ ageH: 2 }), T0);
  assert.equal(r.status, "active");
  assert.equal(r.minToSaveLamports, null);
  assert.equal(r.requiredMinLamports, config.pump.minPumpLamports);
});

test("rule 2: purged post → refused before signing", () => {
  assert.equal(pumpRequirements(post({ ageH: 30, deleted: true }), T0).status, "deleted");
  assert.equal(code(() => assertPumpAllowed(post({ ageH: 30, deleted: true }), 1_000_000_000n, T0)), "post_deleted");
});

test("rule 2: expired post → minimum that really saves it (≥ 1h of life after the pump)", () => {
  const p = post({ ageH: 30 }); // created 30h ago, expired 6h ago, never pumped
  const r = pumpRequirements(p, T0);
  assert.equal(r.status, "expired");
  // needs lifespan ≥ 30h + 1h = 31h → 7h extra in the first tier (24h/SOL) → 0.291666… → 0.292
  assert.equal(r.minToSaveLamports, 292_000_000n);
  // paying exactly that pushes the expiry past now + 1h…
  const saved = expiresAt(p.created_at, 0.292);
  assert.ok(saved.getTime() >= T0.getTime() + config.pump.saveMinLifetimeSeconds * 1000);
  // …and 0.001 SOL less would not
  assert.ok(expiresAt(p.created_at, 0.29).getTime() < T0.getTime() + config.pump.saveMinLifetimeSeconds * 1000);
  assert.equal(code(() => assertPumpAllowed(p, 291_000_000n, T0)), "amount_too_low_to_save");
  assert.equal(code(() => assertPumpAllowed(p, 292_000_000n, T0)), "ok");
});

test("rule 2: the save minimum accounts for SOL already pumped and tier boundaries", () => {
  // 2 SOL already pumped → lifespan 24+24+12 = 60h; created 100h ago → needs 101h
  // → 41h more: 3 SOL at 12h/SOL (36h, up to 5 SOL) then 5h at 6h/SOL (0.8333 SOL)
  const r = pumpRequirements(post({ ageH: 100, lifeH: 60, pumped: 2 }), T0);
  assert.equal(r.minToSaveLamports, 3_834_000_000n);
});

test("rule 2: the modal quote keeps extra margin so it's still valid a few minutes later", () => {
  const p = post({ ageH: 30 });
  const quoted = pumpRequirements(p, T0, config.pump.quoteSlackSeconds).requiredMinLamports;
  const fiveMinLater = new Date(T0.getTime() + 4 * 60_000);
  assert.equal(code(() => assertPumpAllowed(p, quoted, fiveMinLater)), "ok");
});

test("rule 2: the error carries the new minimum for the client", () => {
  try {
    assertPumpAllowed(post({ ageH: 30 }), 10_000_000n, T0);
    assert.fail("should throw");
  } catch (e) {
    const err = e as { statusCode: number; details: Record<string, string>; message: string };
    assert.equal(err.statusCode, 422);
    assert.equal(err.details.required_min_sol, "0.292000000");
    assert.match(err.message, /Il faut au moins 0,292 SOL pour le sauver/);
  }
});

test("formatSolFr", () => {
  assert.equal(formatSolFr("0.292000000"), "0,292");
  assert.equal(formatSolFr("1.000000000"), "1");
  assert.equal(formatSolFr("0.005000000"), "0,005");
});
