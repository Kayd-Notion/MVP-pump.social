/**
 * SOL amounts are handled as integer lamports (bigint) in code and as
 * numeric(20,9) strings in the database — never as floats.
 */
export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** "0.1" | 0.1 → 100000000n. Throws on invalid input or > 9 decimals. */
export function solToLamports(input: string | number): bigint {
  const s = typeof input === "number" ? numberToPlainString(input) : input.trim();
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(s);
  if (!m) throw new Error(`invalid SOL amount: ${input}`);
  const whole = BigInt(m[1]);
  const frac = BigInt((m[2] ?? "").padEnd(9, "0"));
  return whole * LAMPORTS_PER_SOL + frac;
}

/** 100000000n → "0.100000000" (exact, for numeric columns and JSON). */
export function lamportsToSol(lamports: bigint): string {
  const neg = lamports < 0n;
  const abs = neg ? -lamports : lamports;
  const whole = abs / LAMPORTS_PER_SOL;
  const frac = (abs % LAMPORTS_PER_SOL).toString().padStart(9, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** numeric string from Postgres → lamports. */
export function numericToLamports(v: string): bigint {
  return solToLamports(v);
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid SOL amount: ${n}`);
  // toString() may use exponent notation (1e-7); toFixed(9) avoids it and a
  // pump amount never needs more than lamport precision.
  const fixed = n.toFixed(9);
  return fixed.replace(/\.?0+$/, "") || "0";
}
