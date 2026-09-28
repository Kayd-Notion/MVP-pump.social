import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { sql } from "../db.js";
import { recordPump } from "../lib/aggregates.js";
import { UUID_RE } from "../lib/cursor.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { requireUser } from "../lib/guards.js";
import { lamportsToSol, solToLamports } from "../lib/money.js";
import {
  assertAboveMinPump,
  assertPumpAllowed,
  pumpRequirements,
  requirementsJson,
  type PumpablePost,
} from "../lib/pump-rules.js";
import { fetchConfirmedTransaction, isTxSignature, verifyPumpTransaction } from "../lib/solana.js";

function parseAmount(v: string | number): bigint {
  let lamports: bigint;
  try {
    lamports = solToLamports(v);
  } catch {
    throw badRequest("invalid_amount", "Montant invalide (SOL, 9 décimales max).");
  }
  if (lamports <= 0n) throw badRequest("invalid_amount", "Le montant doit être positif.");
  return lamports;
}

export async function pumpRoutes(app: FastifyInstance) {
  /**
   * What the pump modal needs: is the post still pumpable, and what is the
   * minimum amount (MIN_PUMP_SOL, or — for an expired post — the amount that
   * saves it). Computed with a few minutes of margin so the amount shown is
   * still enough when the user confirms.
   */
  app.get<{ Params: { id: string } }>("/posts/:id/pump-quote", async (req) => {
    if (!UUID_RE.test(req.params.id)) throw notFound("post_not_found", "Post introuvable.");
    const [post] = await sql<PumpablePost[]>`
      select created_at, duration_expires_at, deleted_at, total_pumped_sol from posts where id = ${req.params.id}`;
    if (!post) throw notFound("post_not_found", "Post introuvable.");
    const r = pumpRequirements(post, new Date(), config.pump.quoteSlackSeconds);
    return {
      post_id: req.params.id,
      ...requirementsJson(r),
      duration_expires_at: post.duration_expires_at.toISOString(),
      save_min_lifetime_seconds: config.pump.saveMinLifetimeSeconds,
    };
  });

  /**
   * Called by the client right BEFORE building and signing the transaction.
   * Re-checks the rules against the post's state at this exact moment (it may
   * have been purged, or saved by someone else, since the modal opened). If it
   * refuses, no transaction is ever presented to the wallet.
   * On success it creates a short reservation: the purge job won't delete the
   * post while it is active, so a pump being confirmed can't lose its post.
   */
  app.post<{ Body: { post_id: string; amount_sol: string | number } }>(
    "/pumps/prepare",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["post_id", "amount_sol"],
          properties: { post_id: { type: "string" }, amount_sol: { type: ["string", "number"] } },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const me = await requireUser(req);
      const { post_id: postId } = req.body;
      if (!UUID_RE.test(postId)) throw notFound("post_not_found", "Post introuvable.");
      const amount = parseAmount(req.body.amount_sol);
      assertAboveMinPump(amount);

      return sql.begin(async (tx) => {
        // Same row lock as the purge job and the pump recording: the check and
        // the reservation are atomic with respect to a purge.
        const [post] = await tx<PumpablePost[]>`
          select created_at, duration_expires_at, deleted_at, total_pumped_sol
          from posts where id = ${postId} for update`;
        if (!post) throw notFound("post_not_found", "Post introuvable.");
        const r = assertPumpAllowed(post, amount, new Date());
        const expires = new Date(Date.now() + config.pump.intentTtlSeconds * 1000);
        const [intent] = await tx<{ id: string }[]>`
          insert into pump_intents (post_id, wallet_address, amount_sol, expires_at)
          values (${postId}, ${me.wallet_address}, ${lamportsToSol(amount)}, ${expires})
          returning id`;
        return { intent_id: intent.id, expires_at: expires.toISOString(), ...requirementsJson(r) };
      });
    },
  );

  /**
   * Record a pump the client already sent on-chain. Nothing is written until
   * the transaction is confirmed and matches: sender = authenticated wallet,
   * recipients = post creator + platform wallet, split = configured ratio,
   * total = declared amount. tx_signature is unique (anti-replay).
   * Self-pumps (sender = creator) are allowed and flagged (rule 1).
   */
  app.post<{ Body: { post_id: string; tx_signature: string; amount_sol: string | number; intent_id?: string } }>(
    "/pumps",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["post_id", "tx_signature", "amount_sol"],
          properties: {
            post_id: { type: "string" },
            tx_signature: { type: "string" },
            amount_sol: { type: ["string", "number"] },
            intent_id: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const me = await requireUser(req);
      const { post_id: postId, tx_signature: signature } = req.body;
      if (!UUID_RE.test(postId)) throw notFound("post_not_found", "Post introuvable.");
      if (!isTxSignature(signature)) throw badRequest("invalid_signature", "Signature de transaction invalide.");
      const intentId = req.body.intent_id && UUID_RE.test(req.body.intent_id) ? req.body.intent_id : null;
      const declared = parseAmount(req.body.amount_sol);
      // Rule 3 server-side, even if the client skipped /pumps/prepare.
      assertAboveMinPump(declared);

      const [post] = await sql<{ author_wallet: string }[]>`
        select author_wallet from posts where id = ${postId}`;
      if (!post) throw notFound("post_not_found", "Post introuvable.");

      const [dup] = await sql`select 1 from pumps where tx_signature = ${signature}`;
      if (dup) throw conflict("already_recorded", "Cette transaction a déjà été enregistrée.");

      const tx = await fetchConfirmedTransaction(signature);
      const verified = verifyPumpTransaction(tx, {
        payer: me.wallet_address,
        creatorWallet: post.author_wallet,
        platformWallet: config.pump.platformWallet,
        declaredLamports: declared,
        platformBps: config.pump.platformBps,
        maxAgeSeconds: config.pump.maxTxAgeSeconds,
      });

      try {
        const result = await sql.begin((t) =>
          recordPump(t, {
            postId,
            fromWallet: me.wallet_address,
            creatorWallet: post.author_wallet,
            platformWallet: config.pump.platformWallet,
            amountSol: lamportsToSol(verified.totalLamports),
            creatorSol: lamportsToSol(verified.creatorLamports),
            platformSol: lamportsToSol(verified.platformLamports),
            txSignature: signature,
            intentId,
          }),
        );
        if (result.recordedAfterPurge) {
          // Rule 2.4 — the only case where money can be "lost" for the user.
          // Kept visible for a manual refund (see backend/README.md).
          req.log.error(
            {
              event: "PUMP_AFTER_PURGE",
              pump_id: result.pumpId,
              post_id: postId,
              from_wallet: me.wallet_address,
              amount_sol: lamportsToSol(verified.totalLamports),
              tx_signature: signature,
              intent_id: intentId,
            },
            "pump recorded on an already-purged post — refund candidate",
          );
        }
        return reply.status(201).send({
          pump: {
            id: result.pumpId,
            post_id: postId,
            tx_signature: signature,
            amount_sol: lamportsToSol(verified.totalLamports),
            creator_amount_sol: lamportsToSol(verified.creatorLamports),
            platform_amount_sol: lamportsToSol(verified.platformLamports),
            is_self_pump: result.isSelfPump,
            recorded_after_purge: result.recordedAfterPurge,
            created_at: result.createdAt.toISOString(),
          },
          post: {
            id: postId,
            total_pumped_sol: result.totalPumpedSol,
            duration_expires_at: result.expiresAt.toISOString(),
          },
          post_purged: result.recordedAfterPurge,
        });
      } catch (e) {
        // Two concurrent requests with the same signature: the unique index wins.
        if ((e as { code?: string }).code === "23505") {
          throw conflict("already_recorded", "Cette transaction a déjà été enregistrée.");
        }
        throw e;
      }
    },
  );
}
