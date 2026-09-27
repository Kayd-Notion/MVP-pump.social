import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "./db.js";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/**
 * Applies migrations/NNN_*.sql in order, each in its own transaction, recording
 * them in schema_migrations. An advisory lock makes concurrent boots safe.
 */
export async function migrate(sql: Sql, log: (msg: string) => void = console.log): Promise<string[]> {
  const applied: string[] = [];
  await sql.reserve().then(async (conn) => {
    try {
      await conn`select pg_advisory_lock(hashtext('pump.social:migrate'))`;
      await conn`
        create table if not exists schema_migrations (
          version text primary key,
          applied_at timestamptz not null default now()
        )`;
      const done = new Set((await conn`select version from schema_migrations`).map((r) => r.version));
      const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
      for (const file of files) {
        if (done.has(file)) continue;
        const body = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
        // Explicit transaction on the reserved (locked) connection: a failing
        // migration leaves no partial schema behind.
        await conn`begin`;
        try {
          await conn.unsafe(body);
          await conn`insert into schema_migrations (version) values (${file})`;
          await conn`commit`;
        } catch (e) {
          await conn`rollback`;
          throw e;
        }
        applied.push(file);
        log(`migration applied: ${file}`);
      }
    } finally {
      await conn`select pg_advisory_unlock(hashtext('pump.social:migrate'))`;
      conn.release();
    }
  });
  return applied;
}
