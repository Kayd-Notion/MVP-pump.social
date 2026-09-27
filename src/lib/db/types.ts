/** Domain model shared by every storage implementation. Timestamps are ms epoch. */

export type MediaType = "image" | "video";

export interface User {
  id: string;
  handle: string; // pseudo, unique (without @)
  wallet: string; // base58 pubkey, unique
  bio: string;
  country: string; // ISO-2, best-effort from IP at creation, adjustable
  createdAt: number;
  /** Running total of creator shares received (SOL) — for creators leaderboard. */
  received: number;
  /** Running total of SOL this user has sent as pumps. */
  given: number;
  /** Privacy: hide "given" total on public profile. */
  hidePumpHistory: boolean;
  /** Privacy: appear anonymous in pumpers lists by default. */
  anonymizePumps: boolean;
}

export interface Post {
  id: string;
  userId: string;
  text: string;
  mediaUrl: string | null;
  mediaType: MediaType | null;
  createdAt: number;
  /** Cumulative SOL pumped on this post — drives lifespan + posts leaderboard. */
  pumped: number;
  comments: number;
  reposts: number;
  likes: number;
  country: string;
  tags: string[];
}

export interface Pump {
  id: string;
  postId: string;
  pumperUserId: string;
  amount: number; // total SOL
  creatorAmount: number; // SOL to creator
  founderAmount: number; // SOL to founder (Kayd)
  signature: string; // on-chain tx signature
  anonymous: boolean;
  createdAt: number;
  /**
   * Snapshot of the post's creator and country at pump time. Stored on the pump
   * itself so period leaderboards only depend on pump history — they keep
   * working even if the post content is later removed from storage.
   */
  creatorUserId: string;
  postCountry: string;
}

export interface Comment {
  id: string;
  postId: string;
  userId: string;
  text: string;
  createdAt: number;
}

export type LeaderboardKind = "posts" | "creators";
export type LeaderboardScope = "world" | "country";

export interface FeedQuery {
  limit: number;
  /** Cursor: return items created strictly before this ms timestamp. */
  before?: number;
  tab?: "foryou" | "following" | "live";
  authorId?: string;
}

export type LeaderboardPeriod = "all" | "24h" | "7d" | "30d";

/**
 * Keyset cursor: the (total, id) of the last row already returned.
 * `total` is kept as an exact decimal string so equality on ties is reliable.
 */
export interface LeaderboardCursor {
  total: string;
  id: string;
}

export interface LeaderboardQuery {
  kind: LeaderboardKind;
  scope: LeaderboardScope;
  country?: string;
  limit: number;
  /**
   * Window start (ms epoch). Undefined = all time, which reads the cumulative
   * totals (post.pumped / user.received); otherwise pumps are summed from the
   * per-pump log over [since, now].
   */
  since?: number;
  cursor?: LeaderboardCursor;
}

/** A posts-leaderboard row. `post` is null when its content no longer exists. */
export interface PostRankEntry {
  postId: string;
  total: number;
  /** Exact sort key for the next cursor. */
  cursorTotal: string;
  post: PostWithAuthor | null;
  creator: Pick<User, "id" | "handle" | "wallet"> | null;
}

export interface CreatorRankEntry {
  user: User;
  total: number;
  cursorTotal: string;
}

/** A post enriched with its author, ready for the UI. */
export interface PostWithAuthor extends Post {
  author: Pick<User, "id" | "handle" | "wallet" | "bio">;
}

/** A pump enriched with its author. */
export interface PumpWithAuthor extends Pump {
  author: Pick<User, "id" | "handle" | "wallet">;
}

export interface CommentWithAuthor extends Comment {
  author: Pick<User, "id" | "handle" | "wallet">;
}

export interface Store {
  // Users
  getUserById(id: string): Promise<User | null>;
  getUserByWallet(wallet: string): Promise<User | null>;
  getUserByHandle(handle: string): Promise<User | null>;
  createUser(input: {
    handle: string;
    wallet: string;
    bio?: string;
    country?: string;
  }): Promise<User>;
  updateUser(
    id: string,
    patch: Partial<Pick<User, "bio" | "handle" | "hidePumpHistory" | "anonymizePumps">>,
  ): Promise<User>;

  // Posts
  createPost(input: {
    userId: string;
    text: string;
    mediaUrl?: string | null;
    mediaType?: MediaType | null;
    country?: string;
    tags?: string[];
  }): Promise<Post>;
  getPost(id: string): Promise<PostWithAuthor | null>;
  listPosts(q: FeedQuery): Promise<PostWithAuthor[]>;

  // Pumps
  recordPump(input: {
    postId: string;
    pumperUserId: string;
    amount: number;
    creatorAmount: number;
    founderAmount: number;
    signature: string;
    anonymous: boolean;
  }): Promise<{ pump: Pump; post: Post }>;
  getPumpBySignature(signature: string): Promise<Pump | null>;
  listPumpers(postId: string): Promise<PumpWithAuthor[]>;

  // Comments
  addComment(input: { postId: string; userId: string; text: string }): Promise<Comment>;
  listComments(postId: string): Promise<CommentWithAuthor[]>;

  // Leaderboards
  leaderboardPosts(q: LeaderboardQuery): Promise<PostRankEntry[]>;
  leaderboardCreators(q: LeaderboardQuery): Promise<CreatorRankEntry[]>;
}
