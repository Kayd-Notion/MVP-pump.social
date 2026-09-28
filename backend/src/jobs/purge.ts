import { config } from "../config.js";
import { sql } from "../db.js";
import { deleteObject } from "../lib/storage.js";

export interface PurgeResult {
  skipped: boolean;
  postsPurged: number;
  /** Expired posts left alone because a pump is being confirmed (rule 2.4). */
  postsDeferred: number;
  /** Reservations that expired without a recorded pump (logged). */
  intentsFlagged: number;
  mediaDeleted: number;
  orphanUploadsDeleted: number;
  noncesDeleted: number;
}

const BATCH = 200;

/**
 * Purge one post inside a transaction holding its row lock — the same lock
 * taken by POST /pumps/prepare and by pump recording. So either the purge runs
 * first (the pre-check then sees "deleted" and no transaction is signed), or a
 * reservation / pump committed first and the checks below leave the post alone.
 */
async function purgePost(id: string): Promise<"purged" | "media" | "deferred" | "skipped"> {
  return sql.begin(async (tx) => {
    const [post] = await tx<{ media_key: string | null; deleted_at: Date | null; duration_expires_at: Date }[]>`
      select media_key, deleted_at, duration_expires_at from posts where id = ${id} for update`;
    if (!post || post.deleted_at || post.duration_expires_at.getTime() > Date.now()) return "skipped";
    const [busy] = await tx`
      select 1 from pump_intents
      where post_id = ${id} and resolved_at is null and expires_at > now() limit 1`;
    if (busy) return "deferred"; // a pump is being signed/confirmed: retry next run
    // Media before the row: if storage fails, the transaction rolls back and
    // the post is retried next run instead of leaving an orphaned object.
    if (post.media_key) await deleteObject(post.media_key);
    await tx`
      update posts set deleted_at = now(), texte = null, media_url = null, media_key = null
      where id = ${id}`;
    return post.media_key ? "media" : "purged";
  });
}

/**
 * Expiry & real deletion.
 *  1. Every non-deleted post past duration_expires_at that is NOT in the top
 *     KEEP_TOP_N of the all-time posts leaderboard: delete its media object,
 *     then wipe its content and mark it deleted (tombstone). Its `pumps` rows
 *     are never touched (the table is append-only). A post with an active pump
 *     reservation (pump being signed/confirmed) is deferred to a later run.
 *  2. Presigned uploads never attached to a post: delete object + row.
 *  3. Expired sign-in nonces.
 * A Postgres advisory lock ensures only one API instance runs it at a time.
 */
export async function runPurge(log: (m: string) => void = console.log): Promise<PurgeResult> {
  const result: PurgeResult = {
    skipped: false,
    postsPurged: 0,
    postsDeferred: 0,
    intentsFlagged: 0,
    mediaDeleted: 0,
    orphanUploadsDeleted: 0,
    noncesDeleted: 0,
  };
  const conn = await sql.reserve();
  try {
    const [{ locked }] = await conn<{ locked: boolean }[]>`
      select pg_try_advisory_lock(hashtext('pump.social:purge')) as locked`;
    if (!locked) return { ...result, skipped: true };
    try {
      // 1. Expired posts outside the kept top N.
      const seen = new Set<string>();
      for (;;) {
        const batch = await sql<{ id: string }[]>`
          with kept as (
            select id from posts
            where total_pumped_sol > 0
            order by total_pumped_sol desc, id asc
            limit ${config.purge.keepTopN}
          )
          select id from posts p
          where deleted_at is null
            and duration_expires_at <= now()
            and id not in (select id from kept)
            and not exists (
              select 1 from pump_intents i
              where i.post_id = p.id and i.resolved_at is null and i.expires_at > now())
          order by duration_expires_at
          limit ${BATCH}`;
        const fresh = batch.filter((b) => !seen.has(b.id));
        for (const { id } of fresh) {
          seen.add(id);
          const outcome = await purgePost(id);
          if (outcome === "purged") result.postsPurged++;
          if (outcome === "media") {
            result.postsPurged++;
            result.mediaDeleted++;
          }
          if (outcome === "deferred") result.postsDeferred++;
        }
        if (batch.length < BATCH || fresh.length === 0) break;
      }
      // Expired posts skipped above because a pump is in flight (rule 2.4).
      const [{ inFlight }] = await sql<{ inFlight: number }[]>`
        select count(*)::int as "inFlight" from posts p
        where deleted_at is null and duration_expires_at <= now()
          and exists (select 1 from pump_intents i
                      where i.post_id = p.id and i.resolved_at is null and i.expires_at > now())`;
      result.postsDeferred += inFlight;

      // Reservations that expired without their pump being recorded: the
      // client may have crashed after the transfer landed. Logged once, for a
      // manual check on-chain (and refund if needed).
      const stale = await sql<{ id: string; post_id: string; wallet_address: string; amount_sol: string; created_at: Date }[]>`
        update pump_intents set flagged_at = now()
        where resolved_at is null and flagged_at is null and expires_at <= now()
        returning id, post_id, wallet_address, amount_sol, created_at`;
      for (const i of stale) {
        log(
          `pump intent expired without a recorded pump (check on-chain, refund if a transfer landed): ` +
            JSON.stringify({ event: "PUMP_INTENT_UNRESOLVED", ...i }),
        );
      }
      result.intentsFlagged = stale.length;

      // 2. Orphan uploads (presigned but never attached to a post).
      const orphans = await sql<{ object_key: string }[]>`
        select object_key from media_uploads
        where attached_post_id is null
          and created_at < now() - make_interval(secs => ${config.purge.orphanUploadMaxAgeSeconds})
        limit 1000`;
      for (const o of orphans) {
        await deleteObject(o.object_key);
        await sql`delete from media_uploads where object_key = ${o.object_key} and attached_post_id is null`;
        result.orphanUploadsDeleted++;
      }

      // 3. Old nonces (kept a day after expiry for debugging).
      const n = await sql`delete from auth_nonces where expires_at < now() - interval '1 day'`;
      result.noncesDeleted = n.count;
    } finally {
      await conn`select pg_advisory_unlock(hashtext('pump.social:purge'))`;
    }
  } finally {
    conn.release();
  }
  if (result.postsPurged || result.postsDeferred || result.intentsFlagged || result.orphanUploadsDeleted || result.noncesDeleted) {
    log(`purge: ${JSON.stringify(result)}`);
  }
  return result;
}
