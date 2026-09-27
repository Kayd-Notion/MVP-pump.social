import { config } from "../config.js";

/**
 * Creator / platform split of a pump, in lamports. Same rounding as the
 * frontend (src/lib/pump-config.ts): the platform share is floored, the
 * creator gets the remainder, so the parts always sum to the total.
 */
export function splitLamports(
  total: bigint,
  platformBps: number = config.pump.platformBps,
): { creator: bigint; platform: bigint } {
  const platform = (total * BigInt(platformBps)) / 10000n;
  return { creator: total - platform, platform };
}
