import { solToLamports } from "./lib/money.js";

/**
 * All runtime configuration comes from environment variables (see
 * ../.env.example). Parsed and validated once at startup: a misconfigured
 * server refuses to boot instead of failing on the first request.
 */

function str(name: string, fallback?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
}

function int(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer (got "${raw}")`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

function list(name: string, fallback: string): string[] {
  return str(name, fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const cluster = str("SOLANA_CLUSTER", "devnet");

// Rule 3 — minimum pump. THE single place for this value in the backend (the
// frontend reads it from GET /config). 0.005 SOL keeps both shares (70/30)
// above Solana's rent-exempt minimum for an empty recipient wallet.
const minPumpSol = str("MIN_PUMP_SOL", "0.005");
let minPumpLamports: bigint;
try {
  minPumpLamports = solToLamports(minPumpSol);
} catch {
  throw new Error(`MIN_PUMP_SOL must be a SOL amount (got "${minPumpSol}")`);
}
if (!["devnet", "testnet", "mainnet-beta"].includes(cluster)) {
  throw new Error(`SOLANA_CLUSTER must be devnet, testnet or mainnet-beta (got "${cluster}")`);
}

const creatorBps = int("PUMP_CREATOR_BPS", 7000);
if (creatorBps < 0 || creatorBps > 10000) throw new Error("PUMP_CREATOR_BPS must be within 0..10000");

if (!process.env.DATABASE_URL?.trim() && !process.env.PGHOST?.trim()) {
  throw new Error("Set DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE");
}

const jwtSecret = str("JWT_SECRET");
if (jwtSecret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");

export const config = {
  env: str("NODE_ENV", "development"),
  host: str("HOST", "0.0.0.0"),
  port: int("PORT", 4000),
  // Behind a reverse proxy (Caddy on the VPS) set to true so client IPs come
  // from X-Forwarded-For. Keep false when the API is exposed directly.
  trustProxy: bool("TRUST_PROXY", false),
  corsOrigins: list("CORS_ORIGINS", "http://localhost:3000"),

  // Either a full DATABASE_URL, or the standard PGHOST/PGUSER/PGPASSWORD/
  // PGDATABASE variables (used by docker-compose: no URL-encoding pitfalls).
  databaseUrl: process.env.DATABASE_URL?.trim() || null,

  auth: {
    jwtSecret,
    jwtTtlSeconds: int("JWT_TTL_SECONDS", 7 * 24 * 3600),
    nonceTtlSeconds: int("NONCE_TTL_SECONDS", 300),
    // Shown in the sign-in message; set to the real domain in production.
    domain: str("AUTH_DOMAIN", "pump.social"),
  },

  solana: {
    cluster: cluster as "devnet" | "testnet" | "mainnet-beta",
    rpcUrl: str("SOLANA_RPC_URL", "https://api.devnet.solana.com"),
    // Safety: the pump flow is two direct transfers verified off-chain, not an
    // audited program. Refuse mainnet unless explicitly allowed.
    allowMainnet: bool("ALLOW_MAINNET", false),
  },

  pump: {
    platformWallet: str("PLATFORM_WALLET"),
    creatorBps,
    platformBps: 10000 - creatorBps,
    // Reject transactions older than this (a pump is recorded right after it
    // is sent; an old transfer to the creator must not be claimable as a pump).
    maxTxAgeSeconds: int("PUMP_MAX_TX_AGE_SECONDS", 900),
    minPumpLamports,
    // Rule 2 — saving an expired post must give it at least this much life
    // after the pump (otherwise the purge could delete it minutes later).
    saveMinLifetimeSeconds: int("PUMP_SAVE_MIN_LIFETIME_SECONDS", 3600),
    // Rule 2 — lifetime of the reservation made right before signing. Longer
    // than a Solana transaction's validity (~1-2 min of blockhash), so a
    // transfer can't land after its reservation expired.
    intentTtlSeconds: int("PUMP_INTENT_TTL_SECONDS", 180),
    // The amount shown in the modal is computed with this extra margin so it is
    // still sufficient when the user confirms a few minutes later.
    quoteSlackSeconds: 300,
  },

  storage: {
    endpoint: str("S3_ENDPOINT", "http://minio:9000"), // reachable from the API
    publicUrl: str("S3_PUBLIC_URL", "http://localhost:9000"), // reachable from browsers
    region: str("S3_REGION", "us-east-1"),
    bucket: str("S3_BUCKET", "pump-media"),
    accessKey: str("S3_ACCESS_KEY"),
    secretKey: str("S3_SECRET_KEY"),
    maxBytes: int("MEDIA_MAX_BYTES", 25 * 1024 * 1024),
    uploadTtlSeconds: int("MEDIA_UPLOAD_TTL_SECONDS", 600),
  },

  purge: {
    enabled: bool("PURGE_ENABLED", true),
    intervalSeconds: int("PURGE_INTERVAL_SECONDS", 300),
    // Expired posts ranked in the top N of the all-time posts leaderboard are
    // kept forever (content included). Everything else is purged on expiry.
    keepTopN: int("KEEP_TOP_N", 100),
    orphanUploadMaxAgeSeconds: int("ORPHAN_UPLOAD_MAX_AGE_SECONDS", 3600),
  },

  geo: {
    dbPath: str("GEOIP_DB_PATH", "data/dbip-country-lite.mmdb"),
    // Local dev only: country assigned to private/loopback IPs so the
    // "par pays" views can be exercised on localhost. Leave empty in production.
    devDefaultCountry: str("DEV_DEFAULT_COUNTRY", "").toUpperCase() || null,
  },
} as const;

if (config.solana.cluster === "mainnet-beta" && !config.solana.allowMainnet) {
  throw new Error(
    "Refusing to start on mainnet-beta: pumps are unaudited direct transfers. " +
      "Set ALLOW_MAINNET=true only once the on-chain program is audited.",
  );
}

export type Config = typeof config;
