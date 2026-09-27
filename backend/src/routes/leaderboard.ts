import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql } from "../db.js";
import { isWalletAddress } from "../lib/auth.js";
import { decodeCursor, encodeCursor, NUMERIC_RE, UUID_RE } from "../lib/cursor.js";
import { badRequest } from "../lib/errors.js";
import { countryForIp } from "../lib/geo.js";
import type { UserRow } from "../lib/guards.js";
import { postJson, userJson, type PostRow } from "../lib/serialize.js";

type Period = "all" | "24h" | "7d" | "30d";
const WINDOW_MS: Record<Exclude<Period, "all">, number> = {
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
};

interface Query {
  period?: Period;
  scope?: "world" | "country";
  country?: string;
  cursor?: string;
  limit?: number;
}

const querySchema = {
  querystring: {
    type: "object",
    properties: {
      period: { type: "string", enum: ["all", "24h", "7d", "30d"] },
      scope: { type: "string", enum: ["world", "country"] },
      country: { type: "string", pattern: "^[A-Za-z]{2}$" },
      cursor: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
  },
};

/**
 * Shared parsing. With scope=country and no explicit ?country=, the viewer's
 * country is derived from the request IP for this request only (never stored).
 */
function parse(req: FastifyRequest<{ Querystring: Query }>, idCheck: (id: string) => boolean) {
  const q = req.query;
  const period: Period = q.period ?? "all";
  const scope = q.scope ?? "world";
  const country = scope === "country" ? (q.country?.toUpperCase() ?? countryForIp(req.ip)) : null;
  const limit = q.limit ?? 20;
  const cursor = decodeCursor(q.cursor, ["t", "id"]);
  if (cursor && (!NUMERIC_RE.test(cursor.t) || !idCheck(cursor.id))) {
    throw badRequest("invalid_cursor", "Curseur invalide.");
  }
  const since = period === "all" ? null : new Date(Date.now() - WINDOW_MS[period]);
  return { period, scope, country, limit, cursor, since };
}

function page<T extends { rank_total: string }>(rows: T[], limit: number, idOf: (r: T) => string) {
  const last = rows[rows.length - 1];
  return rows.length === limit ? encodeCursor({ t: last.rank_total, id: idOf(last) }) : null;
}

export async function leaderboardRoutes(app: FastifyInstance) {
  /** Posts ranked by SOL pumped (all time or within the period). */
  app.get<{ Querystring: Query }>("/leaderboard/posts", { schema: querySchema }, async (req) => {
    const { period, scope, country, limit, cursor: c, since } = parse(req, (id) => UUID_RE.test(id));
    const meta = { period, scope, country, since: since?.toISOString() ?? null };
    if (scope === "country" && !country) return { ...meta, items: [], next_cursor: null };

    const rows =
      since === null
        ? // All time: derived counter on the post, one index range scan.
          await sql<(PostRow & { rank_total: string })[]>`
            select p.*, u.pseudo as author_pseudo, p.total_pumped_sol::text as rank_total
            from posts p join users u on u.wallet_address = p.author_wallet
            where p.total_pumped_sol > 0
              ${country ? sql`and p.country = ${country}` : sql``}
              ${c ? sql`and (p.total_pumped_sol < ${c.t}::numeric
                            or (p.total_pumped_sol = ${c.t}::numeric and p.id > ${c.id}::uuid))` : sql``}
            order by p.total_pumped_sol desc, p.id asc
            limit ${limit}`
        : // Period: sum the append-only log over the window. Purged posts are
          // tombstones (never hard-deleted), so they still rank here.
          await sql<(PostRow & { rank_total: string })[]>`
            with agg as (
              select pm.post_id, sum(pm.amount_sol) as total
              from pumps pm
              ${country ? sql`join posts pc on pc.id = pm.post_id and pc.country = ${country}` : sql``}
              where pm.created_at >= ${since}
              group by pm.post_id
            )
            select p.*, u.pseudo as author_pseudo, agg.total::text as rank_total
            from agg
            join posts p on p.id = agg.post_id
            join users u on u.wallet_address = p.author_wallet
            ${c ? sql`where agg.total < ${c.t}::numeric or (agg.total = ${c.t}::numeric and agg.post_id > ${c.id}::uuid)` : sql``}
            order by agg.total desc, agg.post_id asc
            limit ${limit}`;

    return {
      ...meta,
      items: rows.map((r) => ({ total_sol: r.rank_total, post: postJson(r) })),
      next_cursor: page(rows, limit, (r) => r.id),
    };
  });

  /** Creators ranked by SOL received (their share), all time or in the period. */
  app.get<{ Querystring: Query }>("/leaderboard/creators", { schema: querySchema }, async (req) => {
    const { period, scope, country, limit, cursor: c, since } = parse(req, isWalletAddress);
    const meta = { period, scope, country, since: since?.toISOString() ?? null };
    if (scope === "country" && !country) return { ...meta, items: [], next_cursor: null };

    type Row = UserRow & { rank_total: string };
    let rows: Row[];
    if (since === null && !country) {
      rows = await sql<Row[]>`
        select u.*, u.total_received_sol::text as rank_total
        from users u
        where u.total_received_sol > 0
          ${c ? sql`and (u.total_received_sol < ${c.t}::numeric
                        or (u.total_received_sol = ${c.t}::numeric and u.wallet_address > ${c.id}))` : sql``}
        order by u.total_received_sol desc, u.wallet_address asc
        limit ${limit}`;
    } else if (since === null) {
      rows = await sql<Row[]>`
        select u.*, t.total_received_sol::text as rank_total
        from creator_country_totals t join users u on u.wallet_address = t.creator_wallet
        where t.country = ${country} and t.total_received_sol > 0
          ${c ? sql`and (t.total_received_sol < ${c.t}::numeric
                        or (t.total_received_sol = ${c.t}::numeric and t.creator_wallet > ${c.id}))` : sql``}
        order by t.total_received_sol desc, t.creator_wallet asc
        limit ${limit}`;
    } else {
      rows = await sql<Row[]>`
        with agg as (
          select pm.to_creator_wallet as wallet, sum(pm.creator_amount_sol) as total
          from pumps pm
          ${country ? sql`join posts pc on pc.id = pm.post_id and pc.country = ${country}` : sql``}
          where pm.created_at >= ${since}
          group by pm.to_creator_wallet
        )
        select u.*, agg.total::text as rank_total
        from agg join users u on u.wallet_address = agg.wallet
        ${c ? sql`where agg.total < ${c.t}::numeric or (agg.total = ${c.t}::numeric and agg.wallet > ${c.id})` : sql``}
        order by agg.total desc, agg.wallet asc
        limit ${limit}`;
    }

    return {
      ...meta,
      items: rows.map((r) => ({ total_sol: r.rank_total, user: userJson(r) })),
      next_cursor: page(rows, limit, (r) => r.wallet_address),
    };
  });
}
