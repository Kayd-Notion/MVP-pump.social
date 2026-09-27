import bs58 from "bs58";
import { config } from "../config.js";
import { HttpError } from "./errors.js";
import { splitLamports } from "./split.js";

/**
 * On-chain verification of a pump. The client already sent a transaction with
 * two System transfers (creator share + platform share); nothing is recorded
 * until the RPC confirms it matches what we expect. The declared amount is
 * only accepted if it equals what actually moved on-chain.
 */

export function isTxSignature(v: unknown): v is string {
  if (typeof v !== "string" || v.length < 64 || v.length > 90) return false;
  try {
    return bs58.decode(v).length === 64;
  } catch {
    return false;
  }
}

// Minimal shape of getTransaction(..., { encoding: "jsonParsed" }).
export interface ParsedTx {
  blockTime: number | null;
  meta: { err: unknown } | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: { pubkey: string; signer: boolean; writable: boolean }[];
      instructions: {
        program?: string;
        programId: string;
        parsed?: { type?: string; info?: Record<string, unknown> };
      }[];
    };
  };
}

const unprocessable = (code: string, msg: string) => new HttpError(422, code, msg);

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(config.solana.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new HttpError(502, "rpc_unavailable", `RPC Solana indisponible (${res.status}).`);
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new HttpError(502, "rpc_error", `Erreur RPC Solana : ${body.error.message}`);
  return body.result as T;
}

/**
 * Fetches a confirmed transaction. Retries briefly: the client calls us right
 * after confirmation and a load-balanced RPC node may lag a little.
 */
export async function fetchConfirmedTransaction(signature: string, attempts = 5): Promise<ParsedTx | null> {
  for (let i = 0; i < attempts; i++) {
    const tx = await rpc<ParsedTx | null>("getTransaction", [
      signature,
      { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    ]);
    if (tx) return tx;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

export interface PumpExpectation {
  payer: string; // authenticated wallet
  creatorWallet: string; // post author
  platformWallet: string;
  declaredLamports: bigint;
  platformBps: number;
  maxAgeSeconds: number;
  now?: number; // ms, injectable for tests
}

export interface VerifiedPump {
  totalLamports: bigint;
  creatorLamports: bigint;
  platformLamports: bigint;
  blockTime: number | null;
}

/** Pure check of a parsed transaction against the expected pump. Throws 422. */
export function verifyPumpTransaction(tx: ParsedTx | null, exp: PumpExpectation): VerifiedPump {
  if (!tx) {
    throw unprocessable("tx_not_found", "Transaction introuvable ou pas encore confirmée sur le réseau.");
  }
  if (!tx.meta || tx.meta.err) throw unprocessable("tx_failed", "La transaction a échoué on-chain.");

  const now = exp.now ?? Date.now();
  if (tx.blockTime !== null) {
    const ageSeconds = (now - tx.blockTime * 1000) / 1000;
    if (ageSeconds > exp.maxAgeSeconds) {
      throw unprocessable("tx_too_old", "Transaction trop ancienne pour être enregistrée comme pump.");
    }
  }

  const keys = tx.transaction.message.accountKeys;
  if (!keys.some((k) => k.pubkey === exp.payer && k.signer)) {
    throw unprocessable("wrong_sender", "La transaction n'est pas signée par le wallet connecté.");
  }

  const sameRecipient = exp.creatorWallet === exp.platformWallet;
  let toCreator = 0n;
  let toPlatform = 0n;
  for (const ix of tx.transaction.message.instructions) {
    if (ix.program !== "system") continue;
    const type = ix.parsed?.type;
    if (type !== "transfer" && type !== "transferWithSeed") continue;
    const info = ix.parsed!.info as { source?: string; from?: string; destination?: string; lamports?: number | string };
    const source = info.source ?? info.from;
    if (source !== exp.payer) continue; // someone else's transfer: not ours to count
    const lamports = BigInt(info.lamports ?? 0);
    if (info.destination === exp.creatorWallet) toCreator += lamports;
    else if (info.destination === exp.platformWallet) toPlatform += lamports;
    else {
      throw unprocessable(
        "unexpected_transfer",
        "La transaction envoie des SOL à un destinataire autre que le créateur et la plateforme.",
      );
    }
  }

  const total = toCreator + toPlatform;
  if (total === 0n) throw unprocessable("no_transfer", "Aucun transfert vers le créateur et la plateforme.");
  if (total !== exp.declaredLamports) {
    throw unprocessable("amount_mismatch", "Le montant déclaré ne correspond pas au montant transféré.");
  }

  const expected = splitLamports(total, exp.platformBps);
  if (sameRecipient) {
    // Creator is the platform wallet: both shares land on one address.
    return { totalLamports: total, creatorLamports: expected.creator, platformLamports: expected.platform, blockTime: tx.blockTime };
  }
  if (toCreator !== expected.creator || toPlatform !== expected.platform) {
    throw unprocessable(
      "split_mismatch",
      `Répartition non conforme (${config.pump.creatorBps / 100} % créateur / ${config.pump.platformBps / 100} % plateforme attendus).`,
    );
  }
  return { totalLamports: total, creatorLamports: toCreator, platformLamports: toPlatform, blockTime: tx.blockTime };
}

