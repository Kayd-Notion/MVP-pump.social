import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { currentUser } from "@/lib/current-user";
import { resolvedSplitBps } from "@/lib/pump-config";
import { verifyPumpTransaction } from "@/lib/verify-pump";
import { solToLamports } from "@/lib/format";
import { lifespanInfo } from "@/lib/lifespan";
import { MIN_PUMP_SOL } from "@/lib/pump-config";
import { formatSolFr } from "@/lib/pump-rules";

export const runtime = "nodejs";

const REQUIRE_VERIFY = process.env.PUMP_REQUIRE_ONCHAIN_VERIFY === "true";

/**
 * Record a completed pump. The on-chain transfer(s) already happened client-side
 * (lib/pump.ts); this persists the off-chain aggregates (post total, creator
 * received, pumper given) that drive lifespan + leaderboards.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const me = await currentUser();
  if (!me) {
    return NextResponse.json({ error: "Connecte ton wallet pour pumper." }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const amount = Number(body?.amount);
  const signature = typeof body?.signature === "string" ? body.signature.trim() : "";
  const anonymous = Boolean(body?.anonymous);

  if (!(amount > 0)) {
    return NextResponse.json({ error: "Montant invalide." }, { status: 400 });
  }
  if (!signature) {
    return NextResponse.json({ error: "Signature de transaction manquante." }, { status: 400 });
  }
  // Rule 3, server-side even if the client skipped the pre-check.
  if (amount < MIN_PUMP_SOL) {
    return NextResponse.json(
      { error: `Minimum ${formatSolFr(MIN_PUMP_SOL)} SOL par pump.`, code: "below_min_pump" },
      { status: 400 },
    );
  }

  const store = getStore();
  const post = await store.getPost(id);
  if (!post) return NextResponse.json({ error: "Post introuvable." }, { status: 404 });

  // Idempotency: never record the same on-chain tx twice.
  if (await store.getPumpBySignature(signature)) {
    return NextResponse.json({ error: "Ce pump a déjà été enregistré." }, { status: 409 });
  }

  // Integrity: re-check the transaction on-chain (prod). Skipped in dev.
  if (REQUIRE_VERIFY) {
    const v = await verifyPumpTransaction({
      signature,
      pumperWallet: me.wallet,
      creatorWallet: post.author.wallet,
      amountSol: amount,
    });
    if (!v.ok) {
      return NextResponse.json({ error: v.reason || "Vérification on-chain échouée." }, { status: 400 });
    }
  }

  // Compute split server-side (never trust client amounts for the aggregates).
  const totalLamports = solToLamports(amount);
  const { creatorBps } = resolvedSplitBps();
  const creatorLamports = Math.floor(totalLamports) - Math.floor((totalLamports * (10000 - creatorBps)) / 10000);
  const founderLamports = Math.floor(totalLamports) - creatorLamports;

  const { post: updated } = await store.recordPump({
    postId: id,
    pumperUserId: me.id,
    amount,
    creatorAmount: creatorLamports / 1e9,
    founderAmount: founderLamports / 1e9,
    signature,
    anonymous: anonymous || me.anonymizePumps,
  });

  const full = await store.getPost(id);
  const info = lifespanInfo(updated.createdAt, updated.pumped);
  return NextResponse.json({
    post: full,
    lifespan: { totalHours: info.totalHours, remainingMs: info.remainingMs, expired: info.expired },
  });
}
