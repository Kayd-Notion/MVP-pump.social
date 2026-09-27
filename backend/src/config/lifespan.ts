/**
 * Post lifespan tiers — kept in its own file so thresholds can be tuned without
 * touching business logic. Mirrors the frontend's src/lib/lifespan-config.ts:
 * keep both in sync (the frontend uses it for display only; the backend's
 * duration_expires_at is authoritative).
 *
 * A post lives `baseHours`, plus, for the cumulative SOL pumped on it, extra
 * hours per SOL according to the segment each SOL falls into. No cap.
 */
export interface LifespanTier {
  /** Lower bound of cumulative pumped SOL for this segment (inclusive). */
  fromSol: number;
  /** Extra hours granted per SOL within this segment. */
  hoursPerSol: number;
}

export const LIFESPAN = {
  baseHours: 24,
  tiers: [
    { fromSol: 0, hoursPerSol: 24 }, //   0–1 SOL   : +24h / SOL
    { fromSol: 1, hoursPerSol: 12 }, //   1–5 SOL   : +12h / SOL
    { fromSol: 5, hoursPerSol: 6 }, //    5–20 SOL  : +6h / SOL
    { fromSol: 20, hoursPerSol: 3 }, //  20–100 SOL : +3h / SOL
    { fromSol: 100, hoursPerSol: 1.5 }, // 100+ SOL : +1.5h / SOL, no cap
  ] as LifespanTier[],
};
