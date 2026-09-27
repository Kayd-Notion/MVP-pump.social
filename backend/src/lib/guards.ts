import type { FastifyRequest } from "fastify";
import { sql } from "../db.js";
import { verifyJwt } from "./auth.js";
import { forbidden, unauthorized } from "./errors.js";

export interface UserRow {
  wallet_address: string;
  pseudo: string;
  created_at: Date;
  total_received_sol: string;
  total_given_sol: string;
}

/** Wallet from a valid `Authorization: Bearer <jwt>`, or 401. */
export async function requireWallet(req: FastifyRequest): Promise<string> {
  const header = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) throw unauthorized("auth_required", "Authentification requise (token Bearer manquant).");
  const wallet = await verifyJwt(m[1].trim());
  if (!wallet) throw unauthorized("invalid_token", "Token invalide ou expiré.");
  return wallet;
}

/** Authenticated wallet that has already created its pseudo, or 401/403. */
export async function requireUser(req: FastifyRequest): Promise<UserRow> {
  const wallet = await requireWallet(req);
  const [user] = await sql<UserRow[]>`select * from users where wallet_address = ${wallet}`;
  if (!user) throw forbidden("pseudo_required", "Crée ton pseudo avant de continuer.");
  return user;
}

export async function findUser(wallet: string): Promise<UserRow | null> {
  const [user] = await sql<UserRow[]>`select * from users where wallet_address = ${wallet}`;
  return user ?? null;
}
