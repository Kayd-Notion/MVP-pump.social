"use client";
import type {
  ClientComment,
  ClientPost,
  ClientPumper,
  ClientUser,
  LeaderboardCreatorItem,
  LeaderboardPeriod,
  LeaderboardPostItem,
} from "./client-types";

/** Thin fetch wrapper: JSON, credentials, and typed errors. */
async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `Erreur ${res.status}`);
  }
  return data as T;
}

export const api = {
  // Auth
  nonce: (wallet: string) =>
    req<{ message: string; nonce: string; issuedAt: number }>(
      `/api/auth/nonce?wallet=${encodeURIComponent(wallet)}`,
    ),
  verify: (wallet: string, signature: string) =>
    req<{ user?: ClientUser; needsOnboarding?: boolean; wallet?: string }>(
      "/api/auth/verify",
      { method: "POST", body: JSON.stringify({ wallet, signature }) },
    ),
  me: () =>
    req<{ user: ClientUser | null; needsOnboarding?: boolean; wallet?: string }>("/api/auth/me"),
  logout: () => req<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),

  // Users
  onboard: (handle: string, bio?: string) =>
    req<{ user: ClientUser }>("/api/users", {
      method: "POST",
      body: JSON.stringify({ handle, bio }),
    }),
  updateMe: (patch: Partial<Pick<ClientUser, "bio" | "handle" | "hidePumpHistory" | "anonymizePumps">>) =>
    req<{ user: ClientUser }>("/api/users/me", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  profile: (handle: string) =>
    req<{
      user: ClientUser;
      postsCount: number;
      active: ClientPost[];
      expiredCount: number;
    }>(`/api/users/${encodeURIComponent(handle)}`),

  // Posts
  feed: (tab: string, before?: number, limit = 20) => {
    const p = new URLSearchParams({ tab, limit: String(limit) });
    if (before) p.set("before", String(before));
    return req<{ posts: ClientPost[]; nextCursor: number | null }>(`/api/posts?${p}`);
  },
  createPost: (input: { text: string; mediaUrl?: string | null; mediaType?: string | null }) =>
    req<{ post: ClientPost }>("/api/posts", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  post: (id: string) =>
    req<{ post: ClientPost; pumpers: ClientPumper[]; comments: ClientComment[] }>(
      `/api/posts/${id}`,
    ),

  // Pump
  recordPump: (postId: string, input: { amount: number; signature: string; anonymous?: boolean }) =>
    req<{ post: ClientPost; lifespan: { totalHours: number; remainingMs: number; expired: boolean } }>(
      `/api/posts/${postId}/pump`,
      { method: "POST", body: JSON.stringify(input) },
    ),

  // Comments
  addComment: (postId: string, text: string) =>
    req<{ comments: ClientComment[] }>(`/api/posts/${postId}/comments`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),

  // Leaderboard
  leaderboard: <K extends "posts" | "creators">(params: {
    kind: K;
    scope: "world" | "country";
    period: LeaderboardPeriod;
    country?: string;
    cursor?: string | null;
    limit?: number;
  }) => {
    const p = new URLSearchParams({
      kind: params.kind,
      scope: params.scope,
      period: params.period,
      limit: String(params.limit ?? 20),
    });
    if (params.country) p.set("country", params.country);
    if (params.cursor) p.set("cursor", params.cursor);
    return req<{
      kind: K;
      scope: string;
      period: LeaderboardPeriod;
      country: string | null;
      items: K extends "creators" ? LeaderboardCreatorItem[] : LeaderboardPostItem[];
      nextCursor: string | null;
    }>(`/api/leaderboard?${p}`);
  },

  geo: () => req<{ country: string }>("/api/geo"),
};
