/**
 * Contract between the UI and its data source. Two implementations:
 *  - lib/api.ts          → the Next.js API routes (default; Vercel preview)
 *  - lib/backend-api.ts  → the standalone backend (NEXT_PUBLIC_API_URL set)
 */
import type {
  ClientComment,
  ClientPost,
  ClientPumper,
  ClientUser,
  LeaderboardCreatorItem,
  LeaderboardPeriod,
  LeaderboardPostItem,
} from "./client-types";
import type { MediaType } from "./db/types";

export interface UploadedMedia {
  url: string;
  type: MediaType;
  /** Object key when stored by the standalone backend (MinIO). */
  key?: string;
}

/** Recipients + ratio a pump transaction must use to be accepted. */
export interface PumpConfig {
  platformWallet: string;
  creatorBps: number;
  platformBps: number;
  /** Rule 3: smallest pump accepted (SOL). */
  minPumpSol: number;
}

/**
 * What the pump modal needs about a post (rule 2 + 3). `deleted` → no pump
 * possible; `expired` → at least `minToSaveSol` to save it.
 */
export interface PumpQuote {
  status: "active" | "expired" | "deleted";
  minPumpSol: number;
  minToSaveSol: number | null;
  /** max(minPumpSol, minToSaveSol) — the confirm button needs at least this. */
  requiredMinSol: number;
}

export interface LeaderboardParams<K extends "posts" | "creators"> {
  kind: K;
  scope: "world" | "country";
  period: LeaderboardPeriod;
  country?: string;
  cursor?: string | null;
  limit?: number;
}

export interface LeaderboardPage<K extends "posts" | "creators"> {
  kind: K;
  period: LeaderboardPeriod;
  country: string | null;
  items: K extends "creators" ? LeaderboardCreatorItem[] : LeaderboardPostItem[];
  nextCursor: string | null;
}

export interface ProfilePage {
  user: ClientUser;
  postsCount: number;
  active: ClientPost[];
  expiredCount: number;
}

export interface Api {
  mode: "next" | "backend";
  /** Features the standalone backend's data model doesn't have (yet). */
  capabilities: { comments: boolean; profileExtras: boolean };

  // Auth
  nonce(wallet: string): Promise<{ message: string }>;
  verify(wallet: string, signature: string): Promise<{ user?: ClientUser; needsOnboarding?: boolean; wallet?: string }>;
  me(): Promise<{ user: ClientUser | null; needsOnboarding?: boolean; wallet?: string }>;
  logout(): Promise<{ ok: boolean }>;

  // Users
  onboard(handle: string, bio?: string): Promise<{ user: ClientUser }>;
  updateMe(
    patch: Partial<Pick<ClientUser, "bio" | "handle" | "hidePumpHistory" | "anonymizePumps">>,
  ): Promise<{ user: ClientUser }>;
  profile(handle: string): Promise<ProfilePage>;

  // Posts
  feed(tab: string, cursor?: string | null, limit?: number): Promise<{ posts: ClientPost[]; nextCursor: string | null }>;
  /** Upload a media file; the result is passed to createPost. */
  uploadMedia(file: File, walletProvider?: unknown): Promise<UploadedMedia>;
  createPost(input: { text: string; media?: UploadedMedia | null }): Promise<{ post: ClientPost }>;
  post(id: string): Promise<{ post: ClientPost; pumpers: ClientPumper[]; comments: ClientComment[] }>;

  // Pump
  pumpConfig(): Promise<PumpConfig>;
  /** Rules for this post right now (shown in the modal). */
  pumpQuote(postId: string): Promise<PumpQuote>;
  /**
   * Server-side re-check right BEFORE signing (post purged meanwhile? amount
   * still enough?). Throws ApiError (code post_deleted | amount_too_low_to_save
   * | below_min_pump, with the new minimum in `data`) → nothing gets signed.
   * Returns a reservation id to pass to recordPump (null if not applicable).
   */
  preparePump(postId: string, amountSol: number): Promise<{ intentId: string | null }>;
  recordPump(
    postId: string,
    input: { amount: number; signature: string; anonymous?: boolean; intentId?: string | null },
  ): Promise<{ post: ClientPost; postPurged?: boolean }>;

  // Comments
  addComment(postId: string, text: string): Promise<{ comments: ClientComment[] }>;

  // Leaderboard
  leaderboard<K extends "posts" | "creators">(params: LeaderboardParams<K>): Promise<LeaderboardPage<K>>;
  geo(): Promise<{ country: string | null }>;
}
