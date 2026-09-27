/**
 * File-backed in-memory store — the default when DATABASE_URL is unset.
 *
 * Persists a single JSON snapshot to `.data/db.json` so data survives dev-server
 * reloads. This is NOT for production (no concurrency guarantees); it exists so
 * the whole app runs and is testable locally without provisioning Postgres.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildSeed } from "./seed";
import type {
  Comment,
  CommentWithAuthor,
  CreatorRankEntry,
  LeaderboardCursor,
  PostRankEntry,
  FeedQuery,
  LeaderboardQuery,
  Post,
  PostWithAuthor,
  Pump,
  PumpWithAuthor,
  Store,
  User,
} from "./types";

interface DbShape {
  users: User[];
  posts: Post[];
  comments: Comment[];
  pumps: Pump[];
}

// On serverless/read-only filesystems (e.g. Vercel) `process.cwd()` isn't
// writable — fall back to the OS temp dir so previews don't crash on writes.
// Data there is ephemeral (per warm instance); use Postgres for durability.
function resolveDataDir(): string {
  if (process.env.PS_DATA_DIR) return process.env.PS_DATA_DIR;
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return path.join(os.tmpdir(), "pump-social");
  }
  return path.join(process.cwd(), ".data");
}
const DATA_DIR = resolveDataDir();
const DATA_FILE = path.join(DATA_DIR, "db.json");

let db: DbShape | null = null;
let loading: Promise<DbShape> | null = null;
let writeChain: Promise<void> = Promise.resolve();

async function load(): Promise<DbShape> {
  if (db) return db;
  if (loading) return loading;
  loading = (async () => {
    try {
      const raw = await fs.readFile(DATA_FILE, "utf8");
      db = JSON.parse(raw) as DbShape;
      if (backfillPumpSnapshots(db)) await persistNow(db);
    } catch {
      db = buildSeed();
      await persistNow(db); // best-effort; safe if the FS is read-only
    }
    return db;
  })();
  return loading;
}

/**
 * Pumps recorded before creator/country were stored on the pump row get them
 * filled from their post (when it still exists). Returns true if anything changed.
 */
function backfillPumpSnapshots(d: DbShape): boolean {
  let changed = false;
  for (const pm of d.pumps) {
    if (pm.creatorUserId && pm.postCountry) continue;
    const post = d.posts.find((p) => p.id === pm.postId);
    if (!post) continue;
    pm.creatorUserId = post.userId;
    pm.postCountry = post.country;
    changed = true;
  }
  return changed;
}

/** Order: total desc, then id asc (stable tie-break shared with the cursor). */
function byTotalThenId(a: { total: number; id: string }, b: { total: number; id: string }) {
  return b.total - a.total || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Keyset filter: keep rows strictly after the cursor in that order. */
function afterCursor(total: number, id: string, cursor?: LeaderboardCursor): boolean {
  if (!cursor) return true;
  const t = Number(cursor.total);
  return total < t || (total === t && id > cursor.id);
}

async function persistNow(snapshot: DbShape): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify(snapshot, null, 2), "utf8");
  } catch {
    // Read-only filesystem (serverless): keep serving from the in-memory copy.
  }
}

function persist(): void {
  // Serialize writes to avoid interleaved file writes clobbering each other.
  writeChain = writeChain.then(() => (db ? persistNow(db) : Promise.resolve())).catch(() => {});
}

function authorOf(u: User) {
  return { id: u.id, handle: u.handle, wallet: u.wallet, bio: u.bio };
}

export function createMemoryStore(): Store {
  const findUser = (d: DbShape, id: string) => d.users.find((u) => u.id === id) || null;

  return {
    async getUserById(id) {
      const d = await load();
      return findUser(d, id);
    },
    async getUserByWallet(wallet) {
      const d = await load();
      return d.users.find((u) => u.wallet === wallet) || null;
    },
    async getUserByHandle(handle) {
      const d = await load();
      const h = handle.toLowerCase();
      return d.users.find((u) => u.handle.toLowerCase() === h) || null;
    },
    async createUser({ handle, wallet, bio = "", country = "FR" }) {
      const d = await load();
      const user: User = {
        id: randomUUID(),
        handle,
        wallet,
        bio: bio || "Nouveau sur pump.social 👋",
        country,
        createdAt: Date.now(),
        received: 0,
        given: 0,
        hidePumpHistory: false,
        anonymizePumps: false,
      };
      d.users.push(user);
      persist();
      return user;
    },
    async updateUser(id, patch) {
      const d = await load();
      const u = findUser(d, id);
      if (!u) throw new Error("user not found");
      Object.assign(u, patch);
      persist();
      return u;
    },

    async createPost({ userId, text, mediaUrl = null, mediaType = null, country = "FR", tags = [] }) {
      const d = await load();
      const post: Post = {
        id: randomUUID(),
        userId,
        text,
        mediaUrl,
        mediaType,
        createdAt: Date.now(),
        pumped: 0,
        comments: 0,
        reposts: 0,
        likes: 0,
        country,
        tags,
      };
      d.posts.push(post);
      persist();
      return post;
    },
    async getPost(id) {
      const d = await load();
      const p = d.posts.find((x) => x.id === id);
      if (!p) return null;
      const author = findUser(d, p.userId);
      if (!author) return null;
      return { ...p, author: authorOf(author) };
    },
    async listPosts(q: FeedQuery) {
      const d = await load();
      let list = d.posts.slice();
      if (q.authorId) list = list.filter((p) => p.userId === q.authorId);
      if (q.before) list = list.filter((p) => p.createdAt < q.before!);

      if (q.tab === "live") {
        list.sort((a, b) => b.createdAt - a.createdAt);
      } else if (q.tab === "foryou") {
        list.sort((a, b) => b.pumped - a.pumped);
      } else {
        // "following" and default: most recent first
        list.sort((a, b) => b.createdAt - a.createdAt);
      }
      list = list.slice(0, q.limit);
      return list
        .map((p) => {
          const author = findUser(d, p.userId);
          return author ? { ...p, author: authorOf(author) } : null;
        })
        .filter((x): x is PostWithAuthor => x !== null);
    },

    async recordPump({ postId, pumperUserId, amount, creatorAmount, founderAmount, signature, anonymous }) {
      const d = await load();
      const post = d.posts.find((p) => p.id === postId);
      if (!post) throw new Error("post not found");
      if (d.pumps.some((p) => p.signature === signature)) {
        throw new Error("duplicate signature");
      }
      const pump: Pump = {
        id: randomUUID(),
        postId,
        pumperUserId,
        amount,
        creatorAmount,
        founderAmount,
        signature,
        anonymous,
        createdAt: Date.now(),
        creatorUserId: post.userId,
        postCountry: post.country,
      };
      d.pumps.push(pump);
      // Aggregates: post total, creator received, pumper given.
      post.pumped += amount;
      const creator = findUser(d, post.userId);
      if (creator) creator.received += creatorAmount;
      const pumper = findUser(d, pumperUserId);
      if (pumper) pumper.given += amount;
      persist();
      return { pump, post: { ...post } };
    },
    async getPumpBySignature(signature) {
      const d = await load();
      return d.pumps.find((p) => p.signature === signature) || null;
    },
    async listPumpers(postId) {
      const d = await load();
      return d.pumps
        .filter((p) => p.postId === postId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((p) => {
          const author = findUser(d, p.pumperUserId);
          return author
            ? { ...p, author: { id: author.id, handle: author.handle, wallet: author.wallet } }
            : null;
        })
        .filter((x): x is PumpWithAuthor => x !== null);
    },

    async addComment({ postId, userId, text }) {
      const d = await load();
      const post = d.posts.find((p) => p.id === postId);
      if (!post) throw new Error("post not found");
      const comment: Comment = {
        id: randomUUID(),
        postId,
        userId,
        text,
        createdAt: Date.now(),
      };
      d.comments.push(comment);
      post.comments += 1;
      persist();
      return comment;
    },
    async listComments(postId) {
      const d = await load();
      return d.comments
        .filter((c) => c.postId === postId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((c) => {
          const author = findUser(d, c.userId);
          return author
            ? { ...c, author: { id: author.id, handle: author.handle, wallet: author.wallet } }
            : null;
        })
        .filter((x): x is CommentWithAuthor => x !== null);
    },

    async leaderboardPosts(q: LeaderboardQuery) {
      const d = await load();
      const byCountry = q.scope === "country" && q.country ? q.country : null;
      let rows: { id: string; total: number; creatorUserId: string | null }[];

      if (q.since === undefined) {
        // All time: cumulative total kept on the post.
        rows = d.posts
          .filter((p) => !byCountry || p.country === byCountry)
          .map((p) => ({ id: p.id, total: p.pumped, creatorUserId: p.userId }));
      } else {
        // Period: sum the per-pump log over the window. Uses only pump history
        // (creator/country snapshots), never the post row, so posts whose
        // content was removed still rank.
        const sums = new Map<string, { total: number; creatorUserId: string | null }>();
        for (const pm of d.pumps) {
          if (pm.createdAt < q.since) continue;
          if (byCountry && pm.postCountry !== byCountry) continue;
          const cur = sums.get(pm.postId) ?? { total: 0, creatorUserId: pm.creatorUserId ?? null };
          cur.total += pm.amount;
          sums.set(pm.postId, cur);
        }
        rows = [...sums].map(([id, v]) => ({ id, ...v }));
      }

      rows = rows
        .filter((r) => afterCursor(r.total, r.id, q.cursor))
        .sort(byTotalThenId)
        .slice(0, q.limit);

      return rows.map((r): PostRankEntry => {
        const post = d.posts.find((p) => p.id === r.id);
        const author = post ? findUser(d, post.userId) : null;
        const creator = findUser(d, post?.userId ?? r.creatorUserId ?? "");
        return {
          postId: r.id,
          total: r.total,
          cursorTotal: String(r.total),
          post: post && author ? { ...post, author: authorOf(author) } : null,
          creator: creator ? { id: creator.id, handle: creator.handle, wallet: creator.wallet } : null,
        };
      });
    },
    async leaderboardCreators(q: LeaderboardQuery) {
      const d = await load();
      const byCountry = q.scope === "country" && q.country ? q.country : null;
      let rows: { id: string; total: number; user: User }[];

      if (q.since === undefined) {
        rows = d.users.map((u) => ({ id: u.id, total: u.received, user: u }));
      } else {
        // Period: sum the creator share of pumps received in the window.
        const sums = new Map<string, number>();
        for (const pm of d.pumps) {
          if (pm.createdAt < q.since || !pm.creatorUserId) continue;
          sums.set(pm.creatorUserId, (sums.get(pm.creatorUserId) ?? 0) + pm.creatorAmount);
        }
        rows = [];
        for (const [id, total] of sums) {
          const user = findUser(d, id);
          if (user) rows.push({ id, total, user });
        }
      }

      return rows
        .filter((r) => !byCountry || r.user.country === byCountry)
        .filter((r) => afterCursor(r.total, r.id, q.cursor))
        .sort(byTotalThenId)
        .slice(0, q.limit)
        .map((r): CreatorRankEntry => ({ user: r.user, total: r.total, cursorTotal: String(r.total) }));
    },
  };
}
