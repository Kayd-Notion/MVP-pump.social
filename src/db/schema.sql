-- pump.social — Postgres schema (Supabase / Neon).
-- Timestamps are stored as bigint (ms epoch) to match the domain model exactly.

create extension if not exists "pgcrypto";

create table if not exists users (
  id                 uuid primary key default gen_random_uuid(),
  handle             text not null unique,
  wallet             text not null unique,
  bio                text not null default '',
  country            text not null default 'FR',
  created_at         bigint not null,
  received           double precision not null default 0,
  given              double precision not null default 0,
  hide_pump_history  boolean not null default false,
  anonymize_pumps    boolean not null default false
);
create index if not exists users_received_idx on users (received desc);
create index if not exists users_country_idx on users (country);

create table if not exists posts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  text        text not null,
  media_url   text,
  media_type  text,
  created_at  bigint not null,
  pumped      double precision not null default 0,
  comments    integer not null default 0,
  reposts     integer not null default 0,
  likes       integer not null default 0,
  country     text not null default 'FR',
  tags        text[] not null default '{}'
);
create index if not exists posts_created_idx on posts (created_at desc);
create index if not exists posts_pumped_idx on posts (pumped desc);
create index if not exists posts_country_idx on posts (country);

-- One row per pump (the per-pump log). It is the source for period
-- leaderboards, so it must outlive post content: post_id deliberately has NO
-- foreign key / ON DELETE CASCADE, and the creator + post country are
-- snapshotted on the row at pump time.
create table if not exists pumps (
  id              uuid primary key default gen_random_uuid(),
  post_id         uuid not null,
  pumper_user_id  uuid not null references users(id) on delete cascade,
  amount          double precision not null,
  creator_amount  double precision not null,
  founder_amount  double precision not null,
  signature       text not null unique,
  anonymous       boolean not null default false,
  created_at      bigint not null,
  creator_user_id uuid,
  post_country    text
);

-- Migration for databases created before the period leaderboards.
alter table pumps add column if not exists creator_user_id uuid;
alter table pumps add column if not exists post_country text;
alter table pumps drop constraint if exists pumps_post_id_fkey;
update pumps pm
  set creator_user_id = p.user_id, post_country = p.country
  from posts p
  where p.id = pm.post_id and (pm.creator_user_id is null or pm.post_country is null);

create index if not exists pumps_post_idx on pumps (post_id, created_at desc);
-- Window scans for period leaderboards (all / by country / by creator).
create index if not exists pumps_created_idx on pumps (created_at);
create index if not exists pumps_country_created_idx on pumps (post_country, created_at);
create index if not exists pumps_creator_created_idx on pumps (creator_user_id, created_at);
-- Keyset pagination on the all-time boards (total desc, id asc).
create index if not exists posts_pumped_id_idx on posts (pumped desc, id);
create index if not exists users_received_id_idx on users (received desc, id);

create table if not exists comments (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references posts(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  text        text not null,
  created_at  bigint not null
);
create index if not exists comments_post_idx on comments (post_id, created_at desc);
