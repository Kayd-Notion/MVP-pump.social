"use client";
import { useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { sendPump } from "@/lib/pump";
import { api } from "@/lib/api";
import type { ClientPost } from "@/lib/client-types";

/**
 * End-to-end pump: build & send the (atomic 2-transfer) Solana transaction
 * client-side, then record it server-side. Returns the updated post.
 * The on-chain step lives in lib/pump.ts — the single place to swap for the
 * future Anchor program.
 */
export function usePump() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();

  const runPump = useCallback(
    async (
      post: ClientPost,
      amountSol: number,
      anonymous: boolean,
    ): Promise<ClientPost> => {
      if (!publicKey || !sendTransaction) {
        throw new Error("Wallet non connecté.");
      }
      // Recipients + ratio from the data source, so the transaction always
      // matches what the backend verifies.
      const cfg = await api.pumpConfig();
      const result = await sendPump({
        connection,
        payer: publicKey,
        creatorWallet: post.author.wallet,
        amountSol,
        sendTransaction,
        target: { platformWallet: cfg.platformWallet, platformBps: cfg.platformBps },
      });
      const { post: updated } = await api.recordPump(post.id, {
        amount: amountSol,
        signature: result.signature,
        anonymous,
      });
      return updated;
    },
    [connection, publicKey, sendTransaction],
  );

  return { runPump, canSign: Boolean(publicKey && sendTransaction) };
}
