import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { publicUser } from "@/lib/current-user";
import { countryFromRequest, normalizeCountry } from "@/lib/geo";
import type {
  LeaderboardCursor,
  LeaderboardKind,
  LeaderboardPeriod,
  LeaderboardScope,
} from "@/lib/db/types";

export const runtime = "nodejs";

const PERIOD_MS: Record<Exclude<LeaderboardPeriod, "all">, number> = {
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
};

function parsePeriod(v: string | null): LeaderboardPeriod {
  return v === "24h" || v === "7d" || v === "30d" ? v : "all";
}

// Opaque cursor = base64url(JSON {total, id}) of the last row returned.
function encodeCursor(c: LeaderboardCursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}
function decodeCursor(raw: string): LeaderboardCursor | null {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof c?.total === "string" && typeof c?.id === "string") return c;
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Two leaderboards (posts by SOL pumped, creators by SOL received), each
 * world or by-country, all-time or over a sliding window (24h / 7d / 30d).
 * Infinite scroll uses a keyset cursor (not offsets), so rows shifting while
 * pumps come in never cause duplicates or skips between pages.
 * Country defaults to the requester's IP-derived country (never stored).
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const kind: LeaderboardKind = sp.get("kind") === "creators" ? "creators" : "posts";
  const scope: LeaderboardScope = sp.get("scope") === "country" ? "country" : "world";
  const period = parsePeriod(sp.get("period"));
  const limit = Math.min(Math.max(Number(sp.get("limit")) || 20, 1), 50);

  const rawCursor = sp.get("cursor");
  const cursor = rawCursor ? decodeCursor(rawCursor) : undefined;
  if (rawCursor && !cursor) {
    return NextResponse.json({ error: "Curseur invalide." }, { status: 400 });
  }

  const country =
    scope === "country"
      ? normalizeCountry(sp.get("country") || countryFromRequest(req))
      : undefined;
  const since = period === "all" ? undefined : Date.now() - PERIOD_MS[period];
  const query = { kind, scope, country, limit, since, cursor: cursor ?? undefined };

  const store = getStore();
  const meta = { kind, scope, period, country: country ?? null };

  if (kind === "creators") {
    const rows = await store.leaderboardCreators(query);
    const last = rows[rows.length - 1];
    return NextResponse.json({
      ...meta,
      items: rows.map((r) => ({ user: publicUser(r.user), total: r.total })),
      nextCursor:
        rows.length === limit ? encodeCursor({ total: last.cursorTotal, id: last.user.id }) : null,
    });
  }

  const rows = await store.leaderboardPosts(query);
  const last = rows[rows.length - 1];
  return NextResponse.json({
    ...meta,
    items: rows.map((r) => ({
      postId: r.postId,
      total: r.total,
      // Post content may be gone (removed from storage) — the row still ranks
      // on its pump history; the client shows it as a removed post.
      deleted: r.post === null,
      post: r.post,
      creator: r.creator,
    })),
    nextCursor:
      rows.length === limit ? encodeCursor({ total: last.cursorTotal, id: last.postId }) : null,
  });
}
