import { LIFESPAN } from "../config/lifespan.js";

const HOUR_MS = 3_600_000;

/** Total lifespan in hours for a post with `totalPumpedSol` cumulative pumps. */
export function lifespanHours(totalPumpedSol: number): number {
  const pumped = Math.max(0, totalPumpedSol);
  const tiers = LIFESPAN.tiers;
  let extra = 0;
  for (let i = 0; i < tiers.length; i++) {
    const from = tiers[i].fromSol;
    const to = i + 1 < tiers.length ? tiers[i + 1].fromSol : Infinity;
    if (pumped <= from) break;
    extra += (Math.min(pumped, to) - from) * tiers[i].hoursPerSol;
  }
  return LIFESPAN.baseHours + extra;
}

export function expiresAt(createdAt: Date, totalPumpedSol: number): Date {
  return new Date(createdAt.getTime() + lifespanHours(totalPumpedSol) * HOUR_MS);
}

/** Initial expiry of a fresh post (no pumps yet): now + base lifespan. */
export function initialExpiry(now = new Date()): Date {
  return expiresAt(now, 0);
}
