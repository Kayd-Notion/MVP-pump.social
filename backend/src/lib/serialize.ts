import type { UserRow } from "./guards.js";

/** Row shape of `posts p join users u` selects (see POST_SELECT in routes). */
export interface PostRow {
  id: string;
  author_wallet: string;
  author_pseudo: string;
  texte: string | null;
  media_url: string | null;
  media_type: "image" | "video" | null;
  country: string | null;
  created_at: Date;
  duration_expires_at: Date;
  deleted_at: Date | null;
  total_pumped_sol: string;
}

/** Public JSON for a post. A purged post is returned as a tombstone. */
export function postJson(p: PostRow) {
  return {
    id: p.id,
    author: { wallet: p.author_wallet, pseudo: p.author_pseudo },
    texte: p.texte,
    media_url: p.media_url,
    media_type: p.media_type,
    country: p.country,
    created_at: p.created_at.toISOString(),
    duration_expires_at: p.duration_expires_at.toISOString(),
    deleted: p.deleted_at !== null,
    // Money as exact decimal strings (SOL, 9 decimals).
    total_pumped_sol: p.total_pumped_sol,
  };
}

export function userJson(u: UserRow) {
  return {
    wallet: u.wallet_address,
    pseudo: u.pseudo,
    created_at: u.created_at.toISOString(),
    total_received_sol: u.total_received_sol,
    total_given_sol: u.total_given_sol,
  };
}
