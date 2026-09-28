"use client";
import { useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { sendPump } from "@/lib/pump";
import { api } from "@/lib/api";
import { humanizePumpError } from "@/lib/pump-errors";
import type { ClientPost } from "@/lib/client-types";

/**
 * End-to-end pump: build & send the (atomic 2-transfer) Solana transaction
 * client-side, then record it server-side. Returns the updated post.
 * The on-chain step lives in lib/pump.ts — the single place to swap for the
 * future Anchor program.
 */
export function usePump() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, signTransaction } = useWallet();

  const runPump = useCallback(
    async (
      post: ClientPost,
      amountSol: number,
      anonymous: boolean,
    ): Promise<{ post: ClientPost; postPurged: boolean }> => {
      if (!publicKey || !sendTransaction) {
        throw new Error("Wallet non connecté.");
      }
      // 1. Server re-check at this exact moment (rules 2 + 3): post purged in
      //    the meantime? amount still enough to save an expired post? If it
      //    refuses (ApiError), we stop here — nothing is ever signed.
      const { intentId } = await api.preparePump(post.id, amountSol);

      // 2. Build + sign + send the atomic 2-transfer transaction (unchanged).
      //    Recipients + ratio come from the data source, so the transaction
      //    always matches what the backend verifies.
      const cfg = await api.pumpConfig();
      let signature: string;
      try {
        const result = await sendPump({
          connection,
          payer: publicKey,
          creatorWallet: post.author.wallet,
          amountSol,
          sendTransaction,
          signTransaction,
          target: { platformWallet: cfg.platformWallet, platformBps: cfg.platformBps },
        });
        signature = result.signature;
      } catch (e) {
        // Wallet / network errors (e.g. rent minimum) → readable message; the
        // raw error stays in the browser console for debugging.
        console.error("pump failed", e);
        throw new Error(humanizePumpError(e));
      }

      // 3. Record it (the backend verifies the transaction on-chain).
      const { post: updated, postPurged } = await api.recordPump(post.id, {
        amount: amountSol,
        signature,
        anonymous,
        intentId,
      });
      return { post: updated, postPurged: Boolean(postPurged) };
    },
    [connection, publicKey, sendTransaction, signTransaction],
  );

  return { runPump, canSign: Boolean(publicKey && sendTransaction) };
}
