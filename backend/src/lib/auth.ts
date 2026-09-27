import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { SignJWT, jwtVerify } from "jose";
import { config } from "../config.js";

const JWT_ISSUER = "pump.social-api";
const JWT_AUDIENCE = "pump.social";
const secret = new TextEncoder().encode(config.auth.jwtSecret);

/** A Solana address is base58 of a 32-byte ed25519 public key. */
export function isWalletAddress(v: unknown): v is string {
  if (typeof v !== "string" || v.length < 32 || v.length > 44) return false;
  try {
    return bs58.decode(v).length === 32;
  } catch {
    return false;
  }
}

export function newNonce(): string {
  return bs58.encode(randomBytes(16));
}

export function signInMessage(p: { wallet: string; nonce: string; issuedAt: Date; expiresAt: Date }): string {
  return [
    `${config.auth.domain} veut que tu te connectes avec ton wallet Solana.`,
    "",
    `Wallet : ${p.wallet}`,
    `Nonce : ${p.nonce}`,
    `Émis le : ${p.issuedAt.toISOString()}`,
    `Expire le : ${p.expiresAt.toISOString()}`,
    "",
    "Signer ce message ne coûte rien et n'autorise aucune transaction.",
  ].join("\n");
}

/** Extracts the nonce line from a sign-in message (the DB row is authoritative). */
export function nonceFromMessage(message: string): string | null {
  return /^Nonce : (\S+)$/m.exec(message)?.[1] ?? null;
}

export function verifyWalletSignature(wallet: string, message: string, signatureB58: string): boolean {
  try {
    const sig = bs58.decode(signatureB58);
    if (sig.length !== 64) return false;
    return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, bs58.decode(wallet));
  } catch {
    return false;
  }
}

export async function issueJwt(wallet: string): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + config.auth.jwtTtlSeconds * 1000);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(wallet)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secret);
  return { token, expiresAt };
}

/** Returns the wallet (JWT subject) or null if the token is invalid/expired. */
export async function verifyJwt(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithms: ["HS256"],
    });
    return typeof payload.sub === "string" && isWalletAddress(payload.sub) ? payload.sub : null;
  } catch {
    return null;
  }
}
