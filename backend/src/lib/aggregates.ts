import type { TransactionSql } from "postgres";
import type { Sql } from "../db.js";
import { expiresAt } from "./lifespan.js";

/**
 * Derived counters kept alongside the append-only `pumps` log:
 *   posts.total_pumped_sol, users.total_received_sol / total_given_sol,
 *   creator_country_totals.
 * They are updated in the SAME transaction as the pump insert, so "all time"
 * leaderboards read one indexed row per post/creator instead of summing the
 * whole log. `pumps` stays the source of truth: rebuildAggregates() recomputes
 * everything from it.
 */

type Tx = TransactionSql;

export interface NewPump {
  postId: string;
  fromWallet: string;
  creatorWallet: string;
  platformWallet: string;
  amountSol: string; // exact numeric strings
  creatorSol: string;
  platformSol: string;
  txSignature: string;
  /** Reservation from POST /pumps/prepare, closed by this pump (optional). */
  intentId?: string | null;
}

/** Insert the pump and update every derived counter + the post's expiry. */
export async function recordPump(tx: Tx, p: NewPump) {
  // Lock the post row: concurrent pumps — and the purge job — serialize here.
  const [post] = await tx<
    { created_at: Date; duration_expires_at: Date; country: string | null; deleted_at: Date | null }[]
  >`select created_at, duration_expires_at, country, deleted_at from posts where id = ${p.postId} for update`;

  // Rule 2, last line of defence: the transfer already happened on-chain and
  // cannot be undone. If the post got purged meanwhile (client skipped the
  // pre-check, or reported long after confirming), the pump is still recorded
  // — hiding a real payment would be worse — but flagged for a manual refund.
  const afterPurge = post.deleted_at !== null;

  const [pump] = await tx<{ id: string; created_at: Date; is_self_pump: boolean }[]>`
    insert into pumps (post_id, from_wallet, to_creator_wallet, to_platform_wallet,
                       amount_sol, creator_amount_sol, platform_amount_sol, tx_signature,
                       recorded_after_purge)
    values (${p.postId}, ${p.fromWallet}, ${p.creatorWallet}, ${p.platformWallet},
            ${p.amountSol}, ${p.creatorSol}, ${p.platformSol}, ${p.txSignature},
            ${afterPurge})
    returning id, created_at, is_self_pump`;

  const [{ total_pumped_sol }] = await tx<{ total_pumped_sol: string }[]>`
    update posts set total_pumped_sol = total_pumped_sol + ${p.amountSol}
    where id = ${p.postId} returning total_pumped_sol`;

  // Extend lifespan per the tier config; never shorten it. (Pointless on a
  // purged post: its content is gone.)
  let newExpiry = post.duration_expires_at;
  if (!afterPurge) {
    const byTiers = expiresAt(post.created_at, Number(total_pumped_sol));
    if (byTiers > newExpiry) newExpiry = byTiers;
    await tx`update posts set duration_expires_at = ${newExpiry} where id = ${p.postId}`;
  }

  // Self-pumps count like any other pump (rule 1: no special treatment).
  await tx`update users set total_received_sol = total_received_sol + ${p.creatorSol}
           where wallet_address = ${p.creatorWallet}`;
  await tx`update users set total_given_sol = total_given_sol + ${p.amountSol}
           where wallet_address = ${p.fromWallet}`;
  if (post.country) {
    await tx`
      insert into creator_country_totals (country, creator_wallet, total_received_sol)
      values (${post.country}, ${p.creatorWallet}, ${p.creatorSol})
      on conflict (country, creator_wallet)
      do update set total_received_sol = creator_country_totals.total_received_sol + excluded.total_received_sol`;
  }

  // Close the reservation made before signing (lets the purge job proceed).
  if (p.intentId) {
    await tx`
      update pump_intents set resolved_at = now(), pump_id = ${pump.id}
      where id = ${p.intentId} and post_id = ${p.postId}
        and wallet_address = ${p.fromWallet} and resolved_at is null`;
  }

  return {
    pumpId: pump.id,
    createdAt: pump.created_at,
    isSelfPump: pump.is_self_pump,
    recordedAfterPurge: afterPurge,
    totalPumpedSol: total_pumped_sol,
    expiresAt: newExpiry,
  };
}

/** Recompute every derived counter from `pumps`. Safe to run anytime. */
export async function rebuildAggregates(sql: Sql) {
  return sql.begin(async (tx) => {
    const posts = await tx`
      update posts p set total_pumped_sol = coalesce(s.total, 0)
      from (select p2.id, (select sum(amount_sol) from pumps where post_id = p2.id) as total from posts p2) s
      where s.id = p.id and p.total_pumped_sol is distinct from coalesce(s.total, 0)`;
    const users = await tx`
      update users u set
        total_received_sol = coalesce((select sum(creator_amount_sol) from pumps where to_creator_wallet = u.wallet_address), 0),
        total_given_sol    = coalesce((select sum(amount_sol) from pumps where from_wallet = u.wallet_address), 0)`;
    await tx`delete from creator_country_totals`;
    const ct = await tx`
      insert into creator_country_totals (country, creator_wallet, total_received_sol)
      select p.country, pm.to_creator_wallet, sum(pm.creator_amount_sol)
      from pumps pm join posts p on p.id = pm.post_id
      where p.country is not null
      group by p.country, pm.to_creator_wallet`;
    return { postsFixed: posts.count, usersUpdated: users.count, countryRows: ct.count };
  });
}
