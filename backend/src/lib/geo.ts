import { existsSync } from "node:fs";
import net from "node:net";
import maxmind, { type CountryResponse, type Reader } from "maxmind";
import { config } from "../config.js";

/**
 * IP → ISO-3166 alpha-2 country, fully self-hosted (DB-IP Lite country mmdb,
 * CC BY 4.0 — attribution "IP Geolocation by DB-IP"). Looked up per request;
 * the IP is never stored. Returns null when unknown.
 */
// DB-IP Lite mmdb uses the GeoIP2 Country layout (country.iso_code).
let reader: Reader<CountryResponse> | null = null;
let loadError: string | null = null;

export async function initGeo(log: (m: string) => void): Promise<void> {
  if (!existsSync(config.geo.dbPath)) {
    loadError = `GeoIP database not found at ${config.geo.dbPath} (run \`npm run geoip:update\`)`;
    log(`${loadError} — country detection disabled`);
    return;
  }
  reader = await maxmind.open<CountryResponse>(config.geo.dbPath);
  log(`GeoIP database loaded: ${config.geo.dbPath}`);
}

export function geoStatus() {
  return { loaded: reader !== null, error: loadError };
}

function isPrivate(ip: string): boolean {
  if (ip === "::1" || ip.startsWith("127.") || ip === "localhost") return true;
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split(".").map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 169;
  }
  return /^f[cd]/i.test(ip) || /^fe80/i.test(ip);
}

export function countryForIp(ip: string | undefined): string | null {
  if (!ip) return null;
  if (isPrivate(ip)) return config.geo.devDefaultCountry;
  if (!reader) return null;
  const clean = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (!net.isIP(clean)) return null;
  const rec = reader.get(clean);
  const code = rec?.country?.iso_code ?? null;
  return code && /^[A-Z]{2}$/.test(code) ? code : null;
}
