import postgres from "postgres";
import { config } from "./config.js";

/**
 * Shared connection pool. numeric columns come back as strings (exact money);
 * convert explicitly where a JS number is acceptable (display only).
 */
const options = { max: 10, onnotice: () => {} };
export const sql = config.databaseUrl
  ? postgres(config.databaseUrl, {
      ...options,
      ssl: config.databaseUrl.includes("sslmode=require") ? "require" : undefined,
    })
  : postgres(options); // reads PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE

export type Sql = typeof sql;
