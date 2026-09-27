import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { sql } from "../db.js";
import {
  isWalletAddress,
  issueJwt,
  newNonce,
  nonceFromMessage,
  signInMessage,
  verifyWalletSignature,
} from "../lib/auth.js";
import { badRequest, unauthorized } from "../lib/errors.js";
import { findUser, requireWallet } from "../lib/guards.js";
import { userJson } from "../lib/serialize.js";

const authRateLimit = { rateLimit: { max: 20, timeWindow: "1 minute" } };

export async function authRoutes(app: FastifyInstance) {
  /** Issue a single-use, short-lived sign-in challenge. */
  app.post<{ Body: { wallet: string } }>(
    "/auth/nonce",
    {
      config: authRateLimit,
      schema: {
        body: {
          type: "object",
          required: ["wallet"],
          properties: { wallet: { type: "string" } },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const { wallet } = req.body;
      if (!isWalletAddress(wallet)) throw badRequest("invalid_wallet", "Adresse de wallet invalide.");
      const nonce = newNonce();
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + config.auth.nonceTtlSeconds * 1000);
      const message = signInMessage({ wallet, nonce, issuedAt, expiresAt });
      await sql`
        insert into auth_nonces (nonce, wallet_address, message, created_at, expires_at)
        values (${nonce}, ${wallet}, ${message}, ${issuedAt}, ${expiresAt})`;
      return { nonce, message, expires_at: expiresAt.toISOString() };
    },
  );

  /** Verify the signed challenge, consume the nonce, return a JWT. */
  app.post<{ Body: { wallet: string; message: string; signature: string } }>(
    "/auth/verify",
    {
      config: authRateLimit,
      schema: {
        body: {
          type: "object",
          required: ["wallet", "message", "signature"],
          properties: {
            wallet: { type: "string" },
            message: { type: "string", maxLength: 2000 },
            signature: { type: "string", maxLength: 200 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const { wallet, message, signature } = req.body;
      if (!isWalletAddress(wallet)) throw badRequest("invalid_wallet", "Adresse de wallet invalide.");
      const nonce = nonceFromMessage(message);
      if (!nonce) throw unauthorized("invalid_challenge", "Message de connexion invalide.");

      // Atomically consume the nonce first: whatever happens next, it can't be
      // replayed (a bad signature burns it and the client asks for a new one).
      const [row] = await sql<{ message: string }[]>`
        update auth_nonces set used_at = now()
        where nonce = ${nonce} and wallet_address = ${wallet}
          and used_at is null and expires_at > now()
        returning message`;
      if (!row) throw unauthorized("challenge_expired", "Défi expiré, déjà utilisé ou inconnu. Réessaie.");
      if (row.message !== message) throw unauthorized("invalid_challenge", "Le message signé ne correspond pas au défi émis.");
      if (!verifyWalletSignature(wallet, message, signature)) {
        throw unauthorized("invalid_signature", "Signature invalide.");
      }

      const { token, expiresAt } = await issueJwt(wallet);
      const user = await findUser(wallet);
      return {
        token,
        token_type: "Bearer",
        expires_at: expiresAt.toISOString(),
        wallet,
        user: user ? userJson(user) : null,
        // No pseudo yet → the frontend shows its pseudo-creation screen.
        needs_pseudo: !user,
      };
    },
  );

  /** Current session: who am I, and do I still need a pseudo? */
  app.get("/me", async (req) => {
    const wallet = await requireWallet(req);
    const user = await findUser(wallet);
    return { wallet, user: user ? userJson(user) : null, needs_pseudo: !user };
  });
}
