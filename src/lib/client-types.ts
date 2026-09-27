/** Client-facing shapes returned by the API (type-only, safe to import in RSC/CSR). */
import type { MediaType } from "./db/types";

export interface ClientUser {
  id: string;
  handle: string;
  wallet: string;
  bio: string;
  country: string;
  received: number;
  given: number;
  hidePumpHistory: boolean;
  anonymizePumps: boolean;
  createdAt: number;
}

export interface ClientPost {
  id: string;
  userId: string;
  text: string;
  mediaUrl: string | null;
  mediaType: MediaType | null;
  createdAt: number;
  pumped: number;
  comments: number;
  reposts: number;
  likes: number;
  country: string;
  tags: string[];
  author: { id: string; handle: string; wallet: string; bio: string };
}

export interface ClientPumper {
  id: string;
  amount: number;
  createdAt: number;
  anonymous: boolean;
  label: string;
  author: { handle: string; wallet: string } | null;
}

export interface ClientComment {
  id: string;
  postId: string;
  userId: string;
  text: string;
  createdAt: number;
  author: { id: string; handle: string; wallet: string };
}

export type LeaderboardPeriod = "all" | "24h" | "7d" | "30d";

/** Posts-leaderboard row. `post` is null (deleted=true) if its content was removed. */
export interface LeaderboardPostItem {
  postId: string;
  /** SOL pumped — all time, or within the selected period. */
  total: number;
  deleted: boolean;
  post: ClientPost | null;
  creator: { id: string; handle: string; wallet: string } | null;
}

export interface LeaderboardCreatorItem {
  user: ClientUser;
  /** SOL received — all time, or within the selected period. */
  total: number;
}
