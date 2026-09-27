/**
 * Apply the Postgres schema and (optionally) seed it.
 *
 * Usage:
 *   DATABASE_URL="postgres://..." node scripts/setup-db.mjs        # schema only
 *   DATABASE_URL="postgres://..." node scripts/setup-db.mjs --seed # schema + seed
 *
 * Safe to re-run: schema uses IF NOT EXISTS; seeding is skipped when users exist.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { buildSeed } from "../src/lib/db/seed.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

// Seed ids are short strings ("u1", "p1"…) for the file store; Postgres ids are
// uuid, so map each to a stable, deterministic uuid.
const uuidOf = (id) => {
  const h = createHash("sha1").update(`pump.social:${id}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const sql = postgres(url, {
  ssl: url.includes("sslmode=require") ? "require" : undefined,
  onnotice: () => {}, // silence "already exists, skipping" notices on re-runs
});

const schema = await readFile(path.join(__dirname, "../src/db/schema.sql"), "utf8");
await sql.unsafe(schema);
console.log("✓ schema applied");

if (process.argv.includes("--seed")) {
  const [{ count }] = await sql`select count(*)::int as count from users`;
  if (count > 0) {
    console.log(`• users already present (${count}) — skipping seed`);
  } else {
    const { users, posts, comments, pumps } = buildSeed();
    for (const u of users) {
      await sql`insert into users (id, handle, wallet, bio, country, created_at, received, given)
        values (${uuidOf(u.id)}, ${u.handle}, ${u.wallet}, ${u.bio}, ${u.country}, ${u.createdAt}, ${u.received}, ${u.given})`;
    }
    for (const p of posts) {
      await sql`insert into posts (id, user_id, text, media_url, media_type, created_at, pumped, comments, reposts, likes, country, tags)
        values (${uuidOf(p.id)}, ${uuidOf(p.userId)}, ${p.text}, ${p.mediaUrl}, ${p.mediaType}, ${p.createdAt}, ${p.pumped}, ${p.comments}, ${p.reposts}, ${p.likes}, ${p.country}, ${sql.array(p.tags)})`;
    }
    for (const c of comments) {
      await sql`insert into comments (id, post_id, user_id, text, created_at)
        values (${uuidOf(c.id)}, ${uuidOf(c.postId)}, ${uuidOf(c.userId)}, ${c.text}, ${c.createdAt})`;
    }
    for (const pm of pumps) {
      await sql`insert into pumps (id, post_id, pumper_user_id, amount, creator_amount, founder_amount, signature, anonymous, created_at, creator_user_id, post_country)
        values (${uuidOf(pm.id)}, ${uuidOf(pm.postId)}, ${uuidOf(pm.pumperUserId)}, ${pm.amount}, ${pm.creatorAmount}, ${pm.founderAmount}, ${pm.signature}, ${pm.anonymous}, ${pm.createdAt}, ${uuidOf(pm.creatorUserId)}, ${pm.postCountry})`;
    }
    console.log(`✓ seeded ${users.length} users, ${posts.length} posts, ${comments.length} comments, ${pumps.length} pumps`);
  }
}

await sql.end();
console.log("done.");
