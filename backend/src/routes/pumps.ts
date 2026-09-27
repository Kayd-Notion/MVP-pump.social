import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { sql } from "../db.js";
import { recordPump } from "../lib/aggregates.js";
import { UUID_RE } from "../lib/cursor.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { requireUser } from "../lib/guards.js";
import { lamportsToSol, solToLamports } from "../lib/money.js";
import { fetchConfirmedTransaction, isTxSignature, verifyPumpTransaction } from "../lib/solana.js";

export async function pumpRoutes(app: FastifyInstance) {
  /**
   * Record a pump the client already sent on-chain. Nothing is written until
   * the transaction is confirmed and matches: sender = authenticated wallet,
   * recipients = post creator + platform wallet, split = configured ratio,
   * total = declared amount. tx_signature is unique (anti-replay).
   */
  app.post<{ Body: { post_id: string; tx_signature: string; amount_sol: string | number } }>(
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
      let declared: bigint;
      try {
        declared = solToLamports(req.body.amount_sol);
      } catch {
        throw badRequest("invalid_amount", "Montant invalide (SOL, 9 décimales max).");
      }
      if (declared <= 0n) throw badRequest("invalid_amount", "Le montant doit être positif.");

      const [post] = await sql<{ author_wallet: string; deleted_at: Date | null }[]>`
        select author_wallet, deleted_at from posts where id = ${postId}`;
      if (!post) throw notFound("post_not_found", "Post introuvable.");
      if (post.deleted_at) throw conflict("post_deleted", "Ce post a été supprimé.");

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
          }),
        );
        return reply.status(201).send({
          pump: {
            id: result.pumpId,
            post_id: postId,
            tx_signature: signature,
            amount_sol: lamportsToSol(verified.totalLamports),
            creator_amount_sol: lamportsToSol(verified.creatorLamports),
            platform_amount_sol: lamportsToSol(verified.platformLamports),
            created_at: result.createdAt.toISOString(),
          },
          post: {
            id: postId,
            total_pumped_sol: result.totalPumpedSol,
            duration_expires_at: result.expiresAt.toISOString(),
          },
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
