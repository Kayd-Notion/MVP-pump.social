import { buildApp } from "./app.js";
import { config } from "./config.js";
import { sql } from "./db.js";
import { runPurge } from "./jobs/purge.js";
import { initGeo } from "./lib/geo.js";
import { initStorage } from "./lib/storage.js";
import { migrate } from "./migrate.js";

const app = await buildApp();
const log = (m: string) => app.log.info(m);

await migrate(sql, log);
await initGeo(log);
await initStorage(log);
await app.listen({ host: config.host, port: config.port });
log(`pump.social API on ${config.host}:${config.port} — Solana ${config.solana.cluster} (${config.solana.rpcUrl})`);

// Scheduled expiry/purge. Runs in-process; the advisory lock inside runPurge
// makes it safe if several API replicas run later.
let timer: NodeJS.Timeout | null = null;
let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    await runPurge(log);
  } catch (e) {
    app.log.error(e, "purge failed");
  } finally {
    running = false;
  }
}
if (config.purge.enabled) {
  setTimeout(tick, 10_000);
  timer = setInterval(tick, config.purge.intervalSeconds * 1000);
  log(`purge scheduled every ${config.purge.intervalSeconds}s (keep top ${config.purge.keepTopN})`);
}

// Graceful shutdown (docker compose stop / restart).
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    log(`${signal} received, shutting down`);
    if (timer) clearInterval(timer);
    await app.close();
    await sql.end({ timeout: 5 });
    process.exit(0);
  });
}
