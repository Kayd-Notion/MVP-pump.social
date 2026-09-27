// Downloads the DB-IP Lite country database (CC BY 4.0, monthly) to
// data/dbip-country-lite.mmdb. Tries the current month, then the previous one
// (a new month's file is published a few days in). Used at Docker build time
// and by `npm run geoip:update` for local runs outside Docker.
import { mkdir, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";

const out = path.resolve(process.argv[2] ?? "data/dbip-country-lite.mmdb");
const now = new Date();
const months = [0, 1, 2].map((back) => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
});

for (const month of months) {
  const url = `https://download.db-ip.com/free/dbip-country-lite-${month}.mmdb.gz`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) {
      console.log(`geoip: ${month} not available (${res.status})`);
      continue;
    }
    const mmdb = gunzipSync(Buffer.from(await res.arrayBuffer()));
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, mmdb);
    console.log(`geoip: saved DB-IP Lite ${month} → ${out} (${(mmdb.length / 1e6).toFixed(1)} MB)`);
    process.exit(0);
  } catch (e) {
    console.log(`geoip: ${month} failed: ${e.message}`);
  }
}
console.error("geoip: could not download the database; country detection will be disabled.");
// Non-fatal: the API still runs (countries resolve to null).
process.exit(0);
