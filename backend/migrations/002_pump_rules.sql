-- Pump product rules: self-pump flag, expired-post protection, refund tracking.

-- Rule 1 — self-pump. Computed by the database from the verified row itself
-- (pumper wallet = creator wallet), so it can never disagree with the data and
-- needs no UPDATE on the append-only table (adding a generated column rewrites
-- the table without firing row triggers).
alter table pumps
  add column is_self_pump boolean generated always as (from_wallet = to_creator_wallet) stored;

-- Rule 2 — a pump whose transfer landed after its post was purged (should not
-- happen thanks to pump_intents, but a client may skip the pre-check or report
-- very late). The money moved on-chain, so the pump IS recorded, flagged for a
-- manual refund:  select * from pumps where recorded_after_purge;
alter table pumps
  add column recorded_after_purge boolean not null default false;
create index pumps_refund_idx on pumps (created_at) where recorded_after_purge;

-- Rule 2 — short-lived reservation created by POST /pumps/prepare right before
-- the wallet signs. While one is active the purge job leaves the post alone, so
-- a pump being confirmed on-chain can't lose its post in between.
create table pump_intents (
  id              uuid primary key default gen_random_uuid(),
  post_id         uuid not null references posts (id) on delete restrict,
  wallet_address  text not null,
  amount_sol      numeric(20,9) not null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  resolved_at     timestamptz,           -- the pump was recorded
  pump_id         uuid references pumps (id),
  flagged_at      timestamptz            -- expired unresolved: logged for manual check
);
create index pump_intents_active_idx on pump_intents (post_id, expires_at) where resolved_at is null;
create index pump_intents_unflagged_idx on pump_intents (expires_at) where resolved_at is null and flagged_at is null;
