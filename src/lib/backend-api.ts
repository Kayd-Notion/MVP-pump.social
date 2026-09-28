"use client";
/**
 * Data source #2: the standalone backend (backend/, docker-compose), enabled by
 * NEXT_PUBLIC_API_URL. Maps its REST API onto the UI's `Api` contract:
 *  - auth: nonce → wallet signature → JWT, sent as `Authorization: Bearer`
 *    (no cross-origin cookie); kept in localStorage;
 *  - media: presigned POST straight to MinIO, then the post references it;
 *  - money comes back as exact decimal strings and is converted for display.
 */
import type {
  ClientPost,
  ClientPumper,
  ClientUser,
  LeaderboardCreatorItem,
  LeaderboardPostItem,
} from "./client-types";
import type { Api, LeaderboardPage, LeaderboardParams, PumpConfig, PumpQuote } from "./api-types";
import { ApiError } from "./api-error";
import { shortWallet } from "./format";

export const BACKEND_URL = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

const TOKEN_KEY = "ps_token";
const store = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (t: string | null) => {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  },
};

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = store.get();
  const res = await fetch(BACKEND_URL + path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string; message?: string };
  if (res.status === 401) store.set(null); // expired/invalid token: back to visitor
  if (!res.ok) throw new ApiError(data.message || data.error || `Erreur ${res.status}`, data.error ?? null, res.status, data);
  return data as T;
}

// ---- backend shapes → UI shapes -------------------------------------------
interface BUser {
  wallet: string;
  pseudo: string;
  created_at: string;
  total_received_sol: string;
  total_given_sol: string;
}
interface BPost {
  id: string;
  author: { wallet: string; pseudo: string };
  texte: string | null;
  media_url: string | null;
  media_type: "image" | "video" | null;
  country: string | null;
  created_at: string;
  duration_expires_at: string;
  deleted: boolean;
  total_pumped_sol: string;
}

function toUser(u: BUser): ClientUser {
  return {
    id: u.wallet,
    handle: u.pseudo,
    wallet: u.wallet,
    bio: "",
    country: "",
    received: Number(u.total_received_sol),
    given: Number(u.total_given_sol),
    hidePumpHistory: false,
    anonymizePumps: false,
    createdAt: Date.parse(u.created_at),
  };
}

function toPost(p: BPost): ClientPost {
  const text = p.texte ?? "";
  return {
    id: p.id,
    userId: p.author.wallet,
    text,
    mediaUrl: p.media_url,
    mediaType: p.media_type,
    createdAt: Date.parse(p.created_at),
    expiresAt: Date.parse(p.duration_expires_at),
    deleted: p.deleted,
    pumped: Number(p.total_pumped_sol),
    comments: 0,
    reposts: 0,
    likes: 0,
    country: p.country ?? "",
    tags: Array.from(new Set((text.match(/#[\p{L}0-9_]+/gu) || []).map((t) => t.toLowerCase()))),
    author: { id: p.author.wallet, handle: p.author.pseudo, wallet: p.author.wallet, bio: "" },
  };
}

/** Same lamport rounding as the transaction (lib/format solToLamports). */
function toSolString(amount: number): string {
  return (Math.round(amount * 1e9) / 1e9).toFixed(9);
}

// The sign-in message comes from /auth/nonce and must be sent back verbatim.
const pendingMessages = new Map<string, string>();
let pumpConfigPromise: Promise<PumpConfig> | null = null;

export const backendApi: Api = {
  mode: "backend",
  // Comments, bio and privacy settings aren't in the backend data model yet.
  capabilities: { comments: false, profileExtras: false },

  // Auth
  nonce: async (wallet) => {
    const r = await call<{ message: string }>("POST", "/auth/nonce", { wallet });
    pendingMessages.set(wallet, r.message);
    return { message: r.message };
  },
  verify: async (wallet, signature) => {
    const message = pendingMessages.get(wallet);
    if (!message) throw new Error("Défi de connexion introuvable, réessaie.");
    pendingMessages.delete(wallet);
    const r = await call<{ token: string; user: BUser | null; needs_pseudo: boolean }>("POST", "/auth/verify", {
      wallet,
      message,
      signature,
    });
    store.set(r.token);
    return r.needs_pseudo ? { needsOnboarding: true, wallet } : { user: toUser(r.user!) };
  },
  me: async () => {
    if (!store.get()) return { user: null };
    try {
      const r = await call<{ wallet: string; user: BUser | null; needs_pseudo: boolean }>("GET", "/me");
      return r.needs_pseudo ? { user: null, needsOnboarding: true, wallet: r.wallet } : { user: toUser(r.user!) };
    } catch {
      return { user: null };
    }
  },
  logout: async () => {
    store.set(null); // stateless JWT: dropping it is the logout
    return { ok: true };
  },

  // Users
  onboard: async (handle) => {
    const r = await call<{ user: BUser }>("POST", "/users", { pseudo: handle });
    return { user: toUser(r.user) };
  },
  updateMe: async (patch) => {
    if (patch.handle) {
      const r = await call<{ user: BUser }>("PATCH", "/users/me", { pseudo: patch.handle });
      return { user: toUser(r.user) };
    }
    const r = await call<{ user: BUser }>("GET", "/me");
    return { user: toUser(r.user) };
  },
  profile: async (handle) => {
    const r = await call<{ user: BUser; posts_count: number; expired_count: number; active: BPost[] }>(
      "GET",
      `/users/${encodeURIComponent(handle)}`,
    );
    return {
      user: toUser(r.user),
      postsCount: r.posts_count,
      expiredCount: r.expired_count,
      active: r.active.map(toPost),
    };
  },

  // Posts (the backend feed is by recency for every tab)
  feed: async (_tab, cursor, limit = 20) => {
    const p = new URLSearchParams({ limit: String(limit) });
    if (cursor) p.set("cursor", cursor);
    const r = await call<{ posts: BPost[]; next_cursor: string | null }>("GET", `/feed?${p}`);
    return { posts: r.posts.map(toPost), nextCursor: r.next_cursor };
  },
  uploadMedia: async (file) => {
    const pre = await call<{
      upload: { url: string; fields: Record<string, string> };
      media_key: string;
      media_url: string;
    }>("POST", "/media/presign", { content_type: file.type, size: file.size });
    const form = new FormData();
    for (const [k, v] of Object.entries(pre.upload.fields)) form.append(k, v);
    form.append("file", file); // must be last
    const res = await fetch(pre.upload.url, { method: "POST", body: form });
    if (!res.ok) throw new Error(`Upload du média refusé (${res.status}).`);
    return { url: pre.media_url, key: pre.media_key, type: file.type.startsWith("video/") ? "video" : "image" };
  },
  createPost: async ({ text, media }) => {
    const r = await call<{ post: BPost }>("POST", "/posts", {
      texte: text,
      ...(media?.key ? { media_key: media.key } : {}),
    });
    return { post: toPost(r.post) };
  },
  post: async (id) => {
    const r = await call<{
      post: BPost;
      pumps: {
        id: string;
        from: { wallet: string; pseudo: string | null };
        amount_sol: string;
        created_at: string;
        is_self_pump: boolean;
      }[];
    }>("GET", `/posts/${id}`);
    const pumpers: ClientPumper[] = r.pumps.map((p) => ({
      id: p.id,
      amount: Number(p.amount_sol),
      createdAt: Date.parse(p.created_at),
      anonymous: false,
      isSelfPump: p.is_self_pump,
      label: p.from.pseudo ?? shortWallet(p.from.wallet),
      author: { handle: p.from.pseudo ?? shortWallet(p.from.wallet), wallet: shortWallet(p.from.wallet) },
    }));
    return { post: toPost(r.post), pumpers, comments: [] };
  },

  // Pump — recipients, ratio and minimum come from the backend itself.
  pumpConfig: () => {
    pumpConfigPromise ??= call<{
      pump: { platform_wallet: string; creator_bps: number; platform_bps: number; min_pump_sol: string };
    }>("GET", "/config")
      .then((r) => ({
        platformWallet: r.pump.platform_wallet,
        creatorBps: r.pump.creator_bps,
        platformBps: r.pump.platform_bps,
        minPumpSol: Number(r.pump.min_pump_sol),
      }))
      .catch((e) => {
        pumpConfigPromise = null;
        throw e;
      });
    return pumpConfigPromise;
  },
  pumpQuote: async (postId) => {
    const r = await call<{ status: PumpQuote["status"]; min_pump_sol: string; min_to_save_sol: string | null; required_min_sol: string }>(
      "GET",
      `/posts/${postId}/pump-quote`,
    );
    return {
      status: r.status,
      minPumpSol: Number(r.min_pump_sol),
      minToSaveSol: r.min_to_save_sol === null ? null : Number(r.min_to_save_sol),
      requiredMinSol: Number(r.required_min_sol),
    };
  },
  preparePump: async (postId, amountSol) => {
    const r = await call<{ intent_id: string }>("POST", "/pumps/prepare", {
      post_id: postId,
      amount_sol: toSolString(amountSol),
    });
    return { intentId: r.intent_id };
  },
  recordPump: async (postId, { amount, signature, intentId }) => {
    const rec = await call<{ post_purged: boolean }>("POST", "/pumps", {
      post_id: postId,
      tx_signature: signature,
      amount_sol: toSolString(amount),
      ...(intentId ? { intent_id: intentId } : {}),
    });
    const r = await call<{ post: BPost }>("GET", `/posts/${postId}`);
    return { post: toPost(r.post), postPurged: rec.post_purged };
  },

  addComment: async () => {
    throw new Error("Les commentaires ne sont pas encore disponibles.");
  },

  // Leaderboard
  leaderboard: async <K extends "posts" | "creators">(params: LeaderboardParams<K>) => {
    const p = new URLSearchParams({ period: params.period, scope: params.scope, limit: String(params.limit ?? 20) });
    if (params.country) p.set("country", params.country);
    if (params.cursor) p.set("cursor", params.cursor);
    const r = await call<{
      period: LeaderboardPage<K>["period"];
      country: string | null;
      items: ({ total_sol: string; post: BPost } | { total_sol: string; user: BUser })[];
      next_cursor: string | null;
    }>("GET", `/leaderboard/${params.kind}?${p}`);
    const items =
      params.kind === "creators"
        ? (r.items as { total_sol: string; user: BUser }[]).map(
            (i): LeaderboardCreatorItem => ({ user: toUser(i.user), total: Number(i.total_sol) }),
          )
        : (r.items as { total_sol: string; post: BPost }[]).map(
            (i): LeaderboardPostItem => ({
              postId: i.post.id,
              total: Number(i.total_sol),
              deleted: i.post.deleted,
              post: i.post.deleted ? null : toPost(i.post),
              creator: { id: i.post.author.wallet, handle: i.post.author.pseudo, wallet: i.post.author.wallet },
            }),
          );
    return {
      kind: params.kind,
      period: r.period,
      country: r.country,
      items: items as LeaderboardPage<K>["items"],
      nextCursor: r.next_cursor,
    };
  },

  geo: () => call<{ country: string | null }>("GET", "/geo"),
};
