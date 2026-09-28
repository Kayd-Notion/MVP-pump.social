import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { sql } from "../db.js";
import { countryForIp, geoStatus } from "../lib/geo.js";
import { storageHealthy } from "../lib/storage.js";
import { lamportsToSol } from "../lib/money.js";

export const ALLOWED_MEDIA_TYPES: Record<string, { ext: string; kind: "image" | "video" }> = {
  "image/jpeg": { ext: "jpg", kind: "image" },
  "image/png": { ext: "png", kind: "image" },
  "image/webp": { ext: "webp", kind: "image" },
  "image/gif": { ext: "gif", kind: "image" },
  "video/mp4": { ext: "mp4", kind: "video" },
  "video/webm": { ext: "webm", kind: "video" },
  "video/quicktime": { ext: "mov", kind: "video" },
};

export async function metaRoutes(app: FastifyInstance) {
  // Liveness + dependencies, used by the Docker healthcheck.
  app.get("/health", { config: { rateLimit: false } }, async (_req, reply) => {
    const [db, storage] = await Promise.all([
      sql`select 1`.then(() => true).catch(() => false),
      storageHealthy(),
    ]);
    const ok = db && storage;
    return reply.status(ok ? 200 : 503).send({ ok, db, storage, geo: geoStatus().loaded });
  });

  /**
   * Public config the frontend needs to build a pump transaction that this
   * backend will accept (single source of truth for wallet + split).
   */
  app.get("/config", async () => ({
    solana: { cluster: config.solana.cluster },
    pump: {
      platform_wallet: config.pump.platformWallet,
      creator_bps: config.pump.creatorBps,
      platform_bps: config.pump.platformBps,
      max_tx_age_seconds: config.pump.maxTxAgeSeconds,
      min_pump_sol: lamportsToSol(config.pump.minPumpLamports),
      save_min_lifetime_seconds: config.pump.saveMinLifetimeSeconds,
    },
    media: { max_bytes: config.storage.maxBytes, content_types: Object.keys(ALLOWED_MEDIA_TYPES) },
  }));

  // Viewer's country from the request IP (computed per request, never stored).
  app.get("/geo", async (req) => ({ country: countryForIp(req.ip) }));
}
