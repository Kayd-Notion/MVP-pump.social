import type { FastifyInstance } from "fastify";
import { sql } from "../db.js";
import { decodeCursor, encodeCursor, UUID_RE } from "../lib/cursor.js";
import { badRequest, notFound } from "../lib/errors.js";
import { countryForIp } from "../lib/geo.js";
import { requireUser } from "../lib/guards.js";
import { initialExpiry } from "../lib/lifespan.js";
import { postJson, type PostRow } from "../lib/serialize.js";
import { deleteObject, headObject, publicUrlFor } from "../lib/storage.js";
import { ALLOWED_MEDIA_TYPES } from "./meta.js";

const MAX_TEXT = 500;

/** Base select for posts with their author's pseudo (a fresh fragment per use). */
export const postSelect = () => sql`
  select p.*, u.pseudo as author_pseudo
  from posts p join users u on u.wallet_address = p.author_wallet`;

// created_at::text round-trips a timestamptz exactly (microseconds included).
const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

export async function postRoutes(app: FastifyInstance) {
  /** Create a post. Optional media must have been uploaded via /media/presign. */
  app.post<{ Body: { texte: string; media_key?: string } }>(
    "/posts",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["texte"],
          properties: { texte: { type: "string" }, media_key: { type: "string", maxLength: 300 } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const me = await requireUser(req);
      const texte = req.body.texte.trim();
      if (!texte) throw badRequest("empty_text", "Écris quelque chose.");
      if (texte.length > MAX_TEXT) throw badRequest("text_too_long", `Texte trop long (max ${MAX_TEXT} caractères).`);

      let media: { key: string; url: string; type: "image" | "video" } | null = null;
      if (req.body.media_key) {
        const key = req.body.media_key;
        const [upload] = await sql<{ content_type: string; max_bytes: string }[]>`
          select content_type, max_bytes from media_uploads
          where object_key = ${key} and wallet_address = ${me.wallet_address} and attached_post_id is null`;
        if (!upload) throw badRequest("invalid_media", "Média inconnu ou déjà utilisé.");
        const head = await headObject(key);
        if (!head) throw badRequest("media_not_uploaded", "Le média n'a pas (encore) été uploadé.");
        if (head.size > Number(upload.max_bytes) || head.contentType !== upload.content_type) {
          await deleteObject(key);
          throw badRequest("media_mismatch", "Le fichier uploadé ne correspond pas à ce qui a été annoncé.");
        }
        media = { key, url: publicUrlFor(key), type: ALLOWED_MEDIA_TYPES[upload.content_type].kind };
      }

      const country = countryForIp(req.ip);
      const post = await sql.begin(async (tx) => {
        const [row] = await tx<{ id: string }[]>`
          insert into posts (author_wallet, texte, media_url, media_key, media_type, country, duration_expires_at)
          values (${me.wallet_address}, ${texte}, ${media?.url ?? null}, ${media?.key ?? null},
                  ${media?.type ?? null}, ${country}, ${initialExpiry()})
          returning id`;
        if (media) {
          const attached = await tx`
            update media_uploads set attached_post_id = ${row.id}
            where object_key = ${media.key} and attached_post_id is null returning object_key`;
          if (attached.length === 0) throw badRequest("invalid_media", "Média déjà utilisé.");
        }
        const [full] = await tx<PostRow[]>`${postSelect()} where p.id = ${row.id}`;
        return full;
      });
      return reply.status(201).send({ post: postJson(post) });
    },
  );

  /** Feed: non-deleted posts, newest first, keyset-paginated. */
  app.get<{ Querystring: { cursor?: string; limit?: number } }>(
    "/feed",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } },
        },
      },
    },
    async (req) => {
      const limit = req.query.limit ?? 20;
      const c = decodeCursor(req.query.cursor, ["ts", "id"]);
      if (c && (!TS_RE.test(c.ts) || !UUID_RE.test(c.id))) throw badRequest("invalid_cursor", "Curseur invalide.");
      const rows = await sql<(PostRow & { cursor_ts: string })[]>`
        select p.*, u.pseudo as author_pseudo, p.created_at::text as cursor_ts
        from posts p join users u on u.wallet_address = p.author_wallet
        where p.deleted_at is null
          ${c ? sql`and (p.created_at, p.id) < (${c.ts}::timestamptz, ${c.id}::uuid)` : sql``}
        order by p.created_at desc, p.id desc
        limit ${limit}`;
      const last = rows[rows.length - 1];
      return {
        posts: rows.map(postJson),
        next_cursor: rows.length === limit ? encodeCursor({ ts: last.cursor_ts, id: last.id }) : null,
      };
    },
  );

  /** One post (a purged post comes back as a tombstone) and its latest pumps. */
  app.get<{ Params: { id: string } }>("/posts/:id", async (req) => {
    if (!UUID_RE.test(req.params.id)) throw notFound("post_not_found", "Post introuvable.");
    const [post] = await sql<PostRow[]>`${postSelect()} where p.id = ${req.params.id}`;
    if (!post) throw notFound("post_not_found", "Post introuvable.");
    const pumps = await sql<
      {
        id: string;
        from_wallet: string;
        pseudo: string | null;
        amount_sol: string;
        created_at: Date;
        tx_signature: string;
        is_self_pump: boolean;
      }[]
    >`
      select pm.id, pm.from_wallet, u.pseudo, pm.amount_sol, pm.created_at, pm.tx_signature, pm.is_self_pump
      from pumps pm left join users u on u.wallet_address = pm.from_wallet
      where pm.post_id = ${post.id}
      order by pm.created_at desc
      limit 100`;
    return {
      post: postJson(post),
      pumps: pumps.map((p) => ({
        id: p.id,
        from: { wallet: p.from_wallet, pseudo: p.pseudo },
        amount_sol: p.amount_sol,
        created_at: p.created_at.toISOString(),
        tx_signature: p.tx_signature,
        is_self_pump: p.is_self_pump, // rule 1: shown as an "auto-pump" badge
      })),
    };
  });
}
