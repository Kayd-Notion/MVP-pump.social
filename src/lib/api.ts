"use client";
import type {
  ClientComment,
  ClientPost,
  ClientPumper,
  ClientUser,
} from "./client-types";
import type { Api, LeaderboardPage, LeaderboardParams, ProfilePage, PumpQuote } from "./api-types";
import { FOUNDER_WALLET, MIN_PUMP_SOL, resolvedSplitBps } from "./pump-config";
import { ApiError } from "./api-error";
import { backendApi, BACKEND_URL } from "./backend-api";

/** Thin fetch wrapper: JSON, credentials, and typed errors. */
async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      (data.error as string) || `Erreur ${res.status}`,
      (data.code as string) ?? null,
      res.status,
      data,
    );
  }
  return data as T;
}

/** Data source #1: this Next.js app's own API routes (/api/*). */
const nextApi: Api = {
  mode: "next",
  capabilities: { comments: true, profileExtras: true },

  // Auth
  nonce: (wallet) => req<{ message: string }>(`/api/auth/nonce?wallet=${encodeURIComponent(wallet)}`),
  verify: (wallet, signature) =>
    req("/api/auth/verify", { method: "POST", body: JSON.stringify({ wallet, signature }) }),
  me: () => req("/api/auth/me"),
  logout: () => req("/api/auth/logout", { method: "POST" }),

  // Users
  onboard: (handle, bio) =>
    req<{ user: ClientUser }>("/api/users", { method: "POST", body: JSON.stringify({ handle, bio }) }),
  updateMe: (patch) =>
    req<{ user: ClientUser }>("/api/users/me", { method: "PATCH", body: JSON.stringify(patch) }),
  profile: (handle) => req<ProfilePage>(`/api/users/${encodeURIComponent(handle)}`),

  // Posts
  feed: async (tab, cursor, limit = 20) => {
    const p = new URLSearchParams({ tab, limit: String(limit) });
    if (cursor) p.set("before", cursor);
    const r = await req<{ posts: ClientPost[]; nextCursor: number | null }>(`/api/posts?${p}`);
    return { posts: r.posts, nextCursor: r.nextCursor === null ? null : String(r.nextCursor) };
  },
  // Arweave via Irys, paid in SOL from the connected wallet.
  uploadMedia: async (file, walletProvider) => {
    const { uploadMedia } = await import("./irys");
    const r = await uploadMedia(file, walletProvider);
    return { url: r.url, type: r.mediaType };
  },
  createPost: ({ text, media }) =>
    req<{ post: ClientPost }>("/api/posts", {
      method: "POST",
      body: JSON.stringify({ text, mediaUrl: media?.url ?? null, mediaType: media?.type ?? null }),
    }),
  post: (id) =>
    req<{ post: ClientPost; pumpers: ClientPumper[]; comments: ClientComment[] }>(`/api/posts/${id}`),

  // Pump
  pumpConfig: async () => {
    const { creatorBps, founderBps } = resolvedSplitBps();
    return { platformWallet: FOUNDER_WALLET, creatorBps, platformBps: founderBps, minPumpSol: MIN_PUMP_SOL };
  },
  pumpQuote: (postId) => req<PumpQuote>(`/api/posts/${postId}/pump-quote`),
  preparePump: async (postId, amountSol) => {
    await req(`/api/posts/${postId}/pump/prepare`, { method: "POST", body: JSON.stringify({ amount: amountSol }) });
    return { intentId: null }; // no purge in this data source → no reservation needed
  },
  recordPump: (postId, { amount, signature, anonymous }) =>
    req<{ post: ClientPost }>(`/api/posts/${postId}/pump`, {
      method: "POST",
      body: JSON.stringify({ amount, signature, anonymous }),
    }),

  // Comments
  addComment: (postId, text) =>
    req<{ comments: ClientComment[] }>(`/api/posts/${postId}/comments`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),

  // Leaderboard
  leaderboard: <K extends "posts" | "creators">(params: LeaderboardParams<K>) => {
    const p = new URLSearchParams({
      kind: params.kind,
      scope: params.scope,
      period: params.period,
      limit: String(params.limit ?? 20),
    });
    if (params.country) p.set("country", params.country);
    if (params.cursor) p.set("cursor", params.cursor);
    return req<LeaderboardPage<K>>(`/api/leaderboard?${p}`);
  },

  geo: () => req<{ country: string }>("/api/geo"),
};

/**
 * The data source the whole UI uses. NEXT_PUBLIC_API_URL set (e.g.
 * http://localhost:4000) → the standalone backend; otherwise the Next routes.
 */
export const api: Api = BACKEND_URL ? backendApi : nextApi;
