import { config } from "../config.js";
import { LIFESPAN } from "../config/lifespan.js";
import { HttpError } from "./errors.js";
import { lamportsToSol } from "./money.js";

/**
 * Product rules applied before a pump is signed (POST /pumps/prepare) and
 * shown in the pump modal (GET /posts/:id/pump-quote):
 *  - rule 3: an amount below MIN_PUMP_SOL is refused;
 *  - rule 2: a purged post can't be pumped; an expired (not yet purged) post
 *    can only be pumped with an amount that actually saves it, i.e. pushes its
 *    expiry to at least now + PUMP_SAVE_MIN_LIFETIME_SECONDS;
 *  - rule 1 (self-pump) needs no check: it is allowed.
 */

const HOUR_MS = 3_600_000;
// The "save" minimum is rounded UP to this step (0.001 SOL) for display.
const SAVE_STEP_LAMPORTS = 1_000_000n;

/**
 * Inverse of lifespanHours(): the cumulative SOL a post needs so its lifespan
 * reaches `targetHours`. Walks the same tiers as config/lifespan.ts.
 */
export function pumpedSolForLifespan(targetHours: number): number {
  let remaining = targetHours - LIFESPAN.baseHours;
  if (remaining <= 0) return 0;
  const tiers = LIFESPAN.tiers;
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

export interface PumpablePost {
  created_at: Date;
  duration_expires_at: Date;
  deleted_at: Date | null;
  total_pumped_sol: string; // numeric
}

export interface PumpRequirements {
  status: PumpPostStatus;
  minPumpLamports: bigint;
  /** Expired posts only: smallest pump that saves the post (null otherwise). */
  minToSaveLamports: bigint | null;
  /** What the modal must require: max(min pump, min to save). */
  requiredMinLamports: bigint;
}

export function pumpRequirements(post: PumpablePost, now: Date, extraMarginSeconds = 0): PumpRequirements {
  const minPump = config.pump.minPumpLamports;
  if (post.deleted_at) {
    return { status: "deleted", minPumpLamports: minPump, minToSaveLamports: null, requiredMinLamports: minPump };
  }
  if (post.duration_expires_at.getTime() > now.getTime()) {
    return { status: "active", minPumpLamports: minPump, minToSaveLamports: null, requiredMinLamports: minPump };
  }
  // Expired, not purged yet: find the pump that moves the tier-based expiry to
  // at least now + save margin.
  const targetMs = now.getTime() + (config.pump.saveMinLifetimeSeconds + extraMarginSeconds) * 1000;
  const targetHours = (targetMs - post.created_at.getTime()) / HOUR_MS;
  const neededTotalSol = pumpedSolForLifespan(targetHours);
  const missingSol = Math.max(0, neededTotalSol - Number(post.total_pumped_sol));
  let minToSave = BigInt(Math.ceil(missingSol * 1e9));
  // Round up to 0.001 SOL so the displayed amount is never an under-estimate.
  if (minToSave % SAVE_STEP_LAMPORTS !== 0n) minToSave += SAVE_STEP_LAMPORTS - (minToSave % SAVE_STEP_LAMPORTS);
  const required = minToSave > minPump ? minToSave : minPump;
  return { status: "expired", minPumpLamports: minPump, minToSaveLamports: minToSave, requiredMinLamports: required };
}

/** JSON view used by the quote endpoint and in error bodies. */
export function requirementsJson(r: PumpRequirements) {
  return {
    status: r.status,
    min_pump_sol: lamportsToSol(r.minPumpLamports),
    min_to_save_sol: r.minToSaveLamports === null ? null : lamportsToSol(r.minToSaveLamports),
    required_min_sol: lamportsToSol(r.requiredMinLamports),
  };
}

/** Rule 3 alone (also enforced when recording, even if the pre-check was skipped). */
export function assertAboveMinPump(amountLamports: bigint): void {
  if (amountLamports < config.pump.minPumpLamports) {
    const min = lamportsToSol(config.pump.minPumpLamports);
    throw new HttpError(400, "below_min_pump", `Minimum ${formatSolFr(min)} SOL par pump.`, { min_pump_sol: min });
  }
}

/** Rules 2 + 3, right before signing. Throws a clear, actionable error. */
export function assertPumpAllowed(post: PumpablePost, amountLamports: bigint, now: Date): PumpRequirements {
  assertAboveMinPump(amountLamports);
  const r = pumpRequirements(post, now);
  if (r.status === "deleted") {
    throw new HttpError(409, "post_deleted", "Ce post a été supprimé : il ne peut plus être pumpé.", requirementsJson(r));
  }
  if (r.status === "expired" && amountLamports < r.requiredMinLamports) {
    const min = lamportsToSol(r.requiredMinLamports);
    throw new HttpError(
      422,
      "amount_too_low_to_save",
      `Ce post est expiré. Il faut au moins ${formatSolFr(min)} SOL pour le sauver.`,
      requirementsJson(r),
    );
  }
  return r;
}

/** "0.417000000" → "0,417" (French display, trailing zeros trimmed). */
export function formatSolFr(numeric: string): string {
  const [whole, frac = ""] = numeric.split(".");
  const f = frac.replace(/0+$/, "");
  return f ? `${whole},${f}` : whole;
}
