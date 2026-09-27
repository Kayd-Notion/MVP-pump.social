import { config } from "../config.js";
import { sql } from "../db.js";
import { deleteObject } from "../lib/storage.js";

export interface PurgeResult {
  skipped: boolean;
  postsPurged: number;
  mediaDeleted: number;
  orphanUploadsDeleted: number;
  noncesDeleted: number;
}

const BATCH = 200;

/**
 * Expiry & real deletion.
 *  1. Every non-deleted post past duration_expires_at that is NOT in the top
 *     KEEP_TOP_N of the all-time posts leaderboard: delete its media object,
 *     then wipe its content and mark it deleted (tombstone). Its `pumps` rows
 *     are never touched (the table is append-only).
 *  2. Presigned uploads never attached to a post: delete object + row.
 *  3. Expired sign-in nonces.
 * A Postgres advisory lock ensures only one API instance runs it at a time.
 */
export async function runPurge(log: (m: string) => void = console.log): Promise<PurgeResult> {
  const result: PurgeResult = { skipped: false, postsPurged: 0, mediaDeleted: 0, orphanUploadsDeleted: 0, noncesDeleted: 0 };
  const conn = await sql.reserve();
  try {
    const [{ locked }] = await conn<{ locked: boolean }[]>`
      select pg_try_advisory_lock(hashtext('pump.social:purge')) as locked`;
    if (!locked) return { ...result, skipped: true };
    try {
      // 1. Expired posts outside the kept top N.
      for (;;) {
        const batch = await sql<{ id: string; media_key: string | null }[]>`
          with kept as (
            select id from posts
            where total_pumped_sol > 0
            order by total_pumped_sol desc, id asc
            limit ${config.purge.keepTopN}
          )
          select id, media_key from posts
          where deleted_at is null
            and duration_expires_at <= now()
            and id not in (select id from kept)
          order by duration_expires_at
          limit ${BATCH}`;
        for (const post of batch) {
          // Media first: if storage fails the post stays live and is retried
          // next run, instead of leaving an orphaned object behind.
          if (post.media_key) {
            await deleteObject(post.media_key);
            result.mediaDeleted++;
          }
          const updated = await sql`
            update posts set deleted_at = now(), texte = null, media_url = null, media_key = null
            where id = ${post.id} and deleted_at is null`;
          result.postsPurged += updated.count;
        }
        if (batch.length < BATCH) break;
      }

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
  if (result.postsPurged || result.orphanUploadsDeleted || result.noncesDeleted) {
    log(`purge: ${JSON.stringify(result)}`);
  }
  return result;
}
