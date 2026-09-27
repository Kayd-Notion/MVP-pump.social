/**
 * Lifespan computation — pure functions built on top of `lifespan-config.ts`.
 * Kept separate from the config so thresholds can change without touching logic.
 */
import { LIFESPAN_CONFIG, type LifespanTier } from "./lifespan-config";

const HOUR_MS = 3600_000;

/**
 * Total lifespan (in hours) for a post given the cumulative SOL pumped on it.
 * base + sum over tiers of (SOL within tier * hoursPerSol). No cap.
 */
export function lifespanHours(totalPumpedSol: number): number {
  const pumped = Math.max(0, totalPumpedSol);
  const tiers: LifespanTier[] = LIFESPAN_CONFIG.tiers;
  let extra = 0;

  for (let i = 0; i < tiers.length; i++) {
    const from = tiers[i].fromSol;
    const to = i + 1 < tiers.length ? tiers[i + 1].fromSol : Infinity;
    if (pumped <= from) break;
    const solInTier = Math.min(pumped, to) - from;
    extra += solInTier * tiers[i].hoursPerSol;
  }

  return LIFESPAN_CONFIG.baseHours + extra;
}

/** Absolute expiry timestamp (ms epoch) for a post. */
export function expiresAt(createdAtMs: number, totalPumpedSol: number): number {
  return createdAtMs + lifespanHours(totalPumpedSol) * HOUR_MS;
}

export interface LifespanInfo {
  totalHours: number;
  remainingMs: number;
  remainingHours: number;
  /** 0..100 — fraction of lifespan remaining, for the gauge. */
  pct: number;
  expired: boolean;
  /** "critical" | "low" | "" — gauge color class, matching the MVP. */
  cls: "critical" | "low" | "";
}

/** Everything the UI needs to render the time gauge. */
export function lifespanInfo(
  createdAtMs: number,
  totalPumpedSol: number,
  nowMs: number = Date.now(),
): LifespanInfo {
  const totalHours = lifespanHours(totalPumpedSol);
  const elapsedMs = nowMs - createdAtMs;
  const totalMs = totalHours * HOUR_MS;
  const remainingMs = totalMs - elapsedMs;
  const remainingHours = remainingMs / HOUR_MS;
  const pct = Math.max(0, Math.min(100, (remainingMs / totalMs) * 100));
  const expired = remainingMs <= 0;
  let cls: LifespanInfo["cls"] = "";
  if (!expired) {
    if (pct < 15) cls = "critical";
    else if (pct < 35) cls = "low";
  }
  return { totalHours, remainingMs, remainingHours, pct, expired, cls };
}

/**
 * Lifespan of a post as the UI should show it: the backend's authoritative
 * expiry when provided (standalone backend), else computed from the tiers.
 */
export function postLifespanInfo(
  post: { createdAt: number; pumped: number; expiresAt?: number },
  nowMs: number = Date.now(),
): LifespanInfo {
  if (post.expiresAt === undefined) return lifespanInfo(post.createdAt, post.pumped, nowMs);
  const totalMs = Math.max(1, post.expiresAt - post.createdAt);
  const remainingMs = post.expiresAt - nowMs;
  const pct = Math.max(0, Math.min(100, (remainingMs / totalMs) * 100));
  const expired = remainingMs <= 0;
  let cls: LifespanInfo["cls"] = "";
  if (!expired) {
    if (pct < 15) cls = "critical";
    else if (pct < 35) cls = "low";
  }
  return { totalHours: totalMs / HOUR_MS, remainingMs, remainingHours: remainingMs / HOUR_MS, pct, expired, cls };
}
