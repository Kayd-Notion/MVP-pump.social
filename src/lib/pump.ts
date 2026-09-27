"use client";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionSignature,
} from "@solana/web3.js";
import { solToLamports } from "./format";
import { splitLamports, FOUNDER_WALLET, resolvedSplitBps } from "./pump-config";
import { IS_MAINNET } from "./solana";

/**
 * PUMP EXECUTION — isolated on purpose.
 *
 * Today a pump is a single Solana transaction containing TWO atomic transfers:
 *   - creator share  → post creator's wallet
 *   - founder share  → Kayd's wallet
 * built and signed client-side (the custom Anchor program isn't deployed yet,
 * guide §3.1). Because both transfers live in one transaction, either both land
 * or neither does — the 70/30 split can't be partially applied.
 *
 * When the Anchor program ships, ONLY this module changes: swap the two
 * SystemProgram.transfer instructions for a single program instruction. The
 * rest of the app calls `buildPumpTransaction` / `sendPump` and is untouched.
 */

export interface PumpQuote {
  amountSol: number;
  creatorLamports: number;
  founderLamports: number;
  creatorSol: number;
  founderSol: number;
}

/**
 * Recipients + ratio of a pump. Defaults come from env (lib/pump-config.ts);
 * with the standalone backend they come from its GET /config, so the
 * transaction always matches what the backend will verify.
 */
export interface PumpTarget {
  platformWallet: string;
  platformBps: number;
}

export function quotePump(amountSol: number, platformBps?: number): PumpQuote {
  const totalLamports = solToLamports(amountSol);
  const { creatorLamports, founderLamports } = splitLamports(totalLamports, platformBps);
  return {
    amountSol,
    creatorLamports,
    founderLamports,
    creatorSol: creatorLamports / 1e9,
    founderSol: founderLamports / 1e9,
  };
}

export interface BuildPumpArgs {
  connection: Connection;
  payer: PublicKey;
  creatorWallet: string;
  /** Overrides the env-configured platform wallet / split. */
  target?: PumpTarget;
  amountSol: number;
}

export async function buildPumpTransaction({
  connection,
  payer,
  creatorWallet,
  amountSol,
  target,
}: BuildPumpArgs): Promise<{ transaction: Transaction; quote: PumpQuote }> {
  if (!(amountSol > 0)) throw new Error("Le montant du pump doit être positif.");
  const platformWallet = target?.platformWallet ?? FOUNDER_WALLET;
  if (!platformWallet) {
    throw new Error("Wallet fondateur non configuré (NEXT_PUBLIC_FOUNDER_WALLET).");
  }

  const creator = new PublicKey(creatorWallet);
  const founder = new PublicKey(platformWallet);
  const quote = quotePump(amountSol, target?.platformBps);

  const tx = new Transaction();

  // Transfer 1 — creator share
  if (quote.creatorLamports > 0) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: creator,
        lamports: quote.creatorLamports,
      }),
    );
  }
  // Transfer 2 — founder (Kayd) share
  if (quote.founderLamports > 0) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: founder,
        lamports: quote.founderLamports,
      }),
    );
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = payer;

  return { transaction: tx, quote };
}

/** Wallet-adapter's sendTransaction signature (kept loose to avoid tight coupling). */
export type SendTransactionFn = (
  transaction: Transaction,
  connection: Connection,
  options?: { skipPreflight?: boolean },
) => Promise<TransactionSignature>;

export interface SendPumpArgs extends BuildPumpArgs {
  sendTransaction: SendTransactionFn;
}

export interface SendPumpResult extends PumpQuote {
  signature: string;
}

/**
 * Build, send and confirm a pump transaction.
 * SECURITY: refuses to run on mainnet — this direct-transfer path is only for
 * pre-audit devnet testing. Remove this guard only once the audited on-chain
 * program is wired in.
 */
export async function sendPump(args: SendPumpArgs): Promise<SendPumpResult> {
  if (IS_MAINNET) {
    throw new Error(
      "Les pumps sont désactivés sur mainnet tant que le programme on-chain n'est pas audité.",
    );
  }
  const { connection, sendTransaction } = args;
  const { transaction, quote } = await buildPumpTransaction(args);

  const signature = await sendTransaction(transaction, connection);
  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash: transaction.recentBlockhash!,
      lastValidBlockHeight: transaction.lastValidBlockHeight!,
    },
    "confirmed",
  );
  if (confirmation.value.err) {
    throw new Error("La transaction de pump a échoué on-chain.");
  }

  return { ...quote, signature };
}

/** Human-readable current split, e.g. "70 / 30". */
export function splitLabel(): string {
  const { creatorBps, founderBps } = resolvedSplitBps();
  return `${creatorBps / 100} / ${founderBps / 100}`;
}
