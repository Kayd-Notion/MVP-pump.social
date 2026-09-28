/**
 * Pump product rules for the Next.js API routes (the standalone backend has
 * its own copy in backend/src/lib/pump-rules.ts — same rules, same tiers).
 *  - rule 2: an expired post can only be pumped with an amount that saves it
 *    (expiry pushed to ≥ now + PUMP_SAVE_MIN_LIFETIME_SECONDS);
 *  - rule 3: nothing below MIN_PUMP_SOL.
 */
import { LIFESPAN_CONFIG } from "./lifespan-config";
import { MIN_PUMP_SOL, PUMP_SAVE_MIN_LIFETIME_SECONDS } from "./pump-config";

const HOUR_MS = 3_600_000;

/** Inverse of lifespanHours(): cumulative SOL needed to reach `targetHours`. */
export function pumpedSolForLifespan(targetHours: number): number {
  let remaining = targetHours - LIFESPAN_CONFIG.baseHours;
  if (remaining <= 0) return 0;
  const tiers = LIFESPAN_CONFIG.tiers;
  for (let i = 0; i < tiers.length; i++) {
    const { fromSol, hoursPerSol } = tiers[i];
    if (hoursPerSol <= 0) continue;
    const to = i + 1 < tiers.length ? tiers[i + 1].fromSol : Infinity;
    const segmentHours = (to - fromSol) * hoursPerSol;
    if (remaining <= segmentHours) return fromSol + remaining / hoursPerSol;
    remaining -= segmentHours;
  }
  return Infinity;
}

export type PumpPostStatus = "active" | "expired" | "deleted";

export interface PumpRequirements {
  status: PumpPostStatus;
  minPumpSol: number;
  minToSaveSol: number | null;
  requiredMinSol: number;
}

/** Round up to 0.001 SOL so a displayed minimum is never an under-estimate. */
function ceilMilli(sol: number): number {
  return Math.ceil(Math.round(sol * 1e9) / 1e6) / 1000;
}

export function pumpRequirements(
  post: { createdAt: number; pumped: number; expiresAt: number; deleted?: boolean },
  nowMs: number,
  extraMarginSeconds = 0,
): PumpRequirements {
  if (post.deleted) return { status: "deleted", minPumpSol: MIN_PUMP_SOL, minToSaveSol: null, requiredMinSol: MIN_PUMP_SOL };
  if (post.expiresAt > nowMs) {
    return { status: "active", minPumpSol: MIN_PUMP_SOL, minToSaveSol: null, requiredMinSol: MIN_PUMP_SOL };
  }
  const targetMs = nowMs + (PUMP_SAVE_MIN_LIFETIME_SECONDS + extraMarginSeconds) * 1000;
  const needed = pumpedSolForLifespan((targetMs - post.createdAt) / HOUR_MS);
  const minToSave = ceilMilli(Math.max(0, needed - post.pumped));
  return { status: "expired", minPumpSol: MIN_PUMP_SOL, minToSaveSol: minToSave, requiredMinSol: Math.max(MIN_PUMP_SOL, minToSave) };
}

/** "0.292" → "0,292" (French, no trailing zeros). */
export function formatSolFr(sol: number): string {
  return (Math.round(sol * 1e9) / 1e9).toLocaleString("fr-FR", { maximumFractionDigits: 9 });
}
