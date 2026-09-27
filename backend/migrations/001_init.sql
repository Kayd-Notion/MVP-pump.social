-- pump.social — initial schema.
-- Money is stored as numeric(20,9): exact to the lamport (1 SOL = 1e9 lamports).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
create table users (
  wallet_address      text primary key,
  pseudo              text not null,
  created_at          timestamptz not null default now(),
  -- Derived counters (rebuildable from `pumps`, see cli/rebuild-aggregates):
  total_received_sol  numeric(20,9) not null default 0, -- creator share received
  total_given_sol     numeric(20,9) not null default 0  -- SOL sent as pumps
);
-- Pseudo uniqueness is case-insensitive ("Satoshi" and "satoshi" collide).
create unique index users_pseudo_lower_key on users (lower(pseudo));
create index users_received_rank_idx on users (total_received_sol desc, wallet_address);

-- ---------------------------------------------------------------------------
-- posts
-- A purged post is kept as a tombstone: deleted_at set, content (texte,
-- media) wiped, so pumps keep a valid post_id and leaderboards can still show
-- it ("post supprimé") with its author and country.
-- ---------------------------------------------------------------------------
create table posts (
  id                   uuid primary key default gen_random_uuid(),
  author_wallet        text not null references users (wallet_address),
  texte                text,
  media_url            text,
  media_key            text,            -- object key in the media bucket
  media_type           text check (media_type in ('image', 'video')),
  -- ISO-3166 alpha-2 of the author's IP at creation time (the IP itself is
  -- never stored). Null when unknown. Drives the "par pays" leaderboards.
  country              char(2),
  created_at           timestamptz not null default now(),
  duration_expires_at  timestamptz not null,
  deleted_at           timestamptz,
  -- Derived counter (rebuildable from `pumps`): total SOL pumped, all time.
  total_pumped_sol     numeric(20,9) not null default 0,
  constraint posts_live_has_text check (deleted_at is not null or texte is not null),
  constraint posts_deleted_has_no_content
    check (deleted_at is null or (texte is null and media_url is null and media_key is null))
);
create index posts_feed_idx on posts (created_at desc, id desc) where deleted_at is null;
create index posts_expiry_idx on posts (duration_expires_at) where deleted_at is null;
create index posts_author_idx on posts (author_wallet, created_at desc);
create index posts_total_rank_idx on posts (total_pumped_sol desc, id);
create index posts_country_total_rank_idx on posts (country, total_pumped_sol desc, id);

-- ---------------------------------------------------------------------------
-- pumps — append-only log, the source of truth for every pump aggregate.
-- ON DELETE RESTRICT + tombstoned posts: a post with pumps can never be
-- hard-deleted, and the triggers below forbid UPDATE / DELETE / TRUNCATE.
-- ---------------------------------------------------------------------------
create table pumps (
  id                   uuid primary key default gen_random_uuid(),
  post_id              uuid not null references posts (id) on delete restrict,
  from_wallet          text not null,
  to_creator_wallet    text not null,
  to_platform_wallet   text not null,
  amount_sol           numeric(20,9) not null check (amount_sol > 0),
  -- Split as verified on-chain (the ratio is configurable, so it is recorded
  -- per pump rather than recomputed).
  creator_amount_sol   numeric(20,9) not null check (creator_amount_sol >= 0),
  platform_amount_sol  numeric(20,9) not null check (platform_amount_sol >= 0),
  tx_signature         text not null unique,
  created_at           timestamptz not null default now(),
  constraint pumps_split_sums check (creator_amount_sol + platform_amount_sol = amount_sol)
);
-- Period leaderboards scan a created_at window; INCLUDE makes it index-only.
create index pumps_window_idx on pumps (created_at)
  include (post_id, amount_sol, to_creator_wallet, creator_amount_sol);
create index pumps_post_idx on pumps (post_id, created_at desc);
create index pumps_creator_idx on pumps (to_creator_wallet, created_at);
create index pumps_from_idx on pumps (from_wallet, created_at desc);

create function pumps_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'pumps is append-only: % is not allowed', tg_op;
end;
$$;
create trigger pumps_no_update_delete before update or delete on pumps
  for each row execute function pumps_append_only();
create trigger pumps_no_truncate before truncate on pumps
  for each statement execute function pumps_append_only();

-- Derived counter (rebuildable): creator totals per post country, for the
-- all-time "créateurs · pays" leaderboard without scanning `pumps`.
create table creator_country_totals (
  country             char(2) not null,
  creator_wallet      text not null,
  total_received_sol  numeric(20,9) not null default 0,
  primary key (country, creator_wallet)
);
create index creator_country_rank_idx
  on creator_country_totals (country, total_received_sol desc, creator_wallet);

-- ---------------------------------------------------------------------------
-- auth_nonces — single-use sign-in challenges.
-- ---------------------------------------------------------------------------
create table auth_nonces (
  nonce           text primary key,
  wallet_address  text not null,
  message         text not null,    -- exact text the wallet must sign
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  used_at         timestamptz
);
create index auth_nonces_expires_idx on auth_nonces (expires_at);

-- ---------------------------------------------------------------------------
-- media_uploads — presigned uploads, so a post can only attach an object its
-- author uploaded, and never-attached uploads get cleaned up.
-- ---------------------------------------------------------------------------
create table media_uploads (
  object_key        text primary key,
  wallet_address    text not null,
  content_type      text not null,
  max_bytes         bigint not null,
  created_at        timestamptz not null default now(),
  attached_post_id  uuid references posts (id)
);
create index media_uploads_orphan_idx on media_uploads (created_at) where attached_post_id is null;
