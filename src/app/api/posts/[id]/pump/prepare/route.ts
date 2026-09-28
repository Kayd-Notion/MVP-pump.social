import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { currentUser } from "@/lib/current-user";
import { expiresAt } from "@/lib/lifespan";
import { MIN_PUMP_SOL } from "@/lib/pump-config";
import { formatSolFr, pumpRequirements } from "@/lib/pump-rules";

export const runtime = "nodejs";

/**
 * Re-check right BEFORE the wallet signs (rules 2 + 3). If this refuses, the
 * client never builds nor signs the transaction.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "Connecte ton wallet pour pumper.", code: "auth_required" }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const amount = Number(body?.amount);
  if (!(amount > 0)) return NextResponse.json({ error: "Montant invalide.", code: "invalid_amount" }, { status: 400 });
  if (amount < MIN_PUMP_SOL) {
    return NextResponse.json(
      { error: `Minimum ${formatSolFr(MIN_PUMP_SOL)} SOL par pump.`, code: "below_min_pump", minPumpSol: MIN_PUMP_SOL },
      { status: 400 },
    );
  }

  const post = await getStore().getPost(id);
  if (!post) {
    return NextResponse.json({ error: "Ce post a été supprimé : il ne peut plus être pumpé.", code: "post_deleted" }, { status: 409 });
  }
  const r = pumpRequirements(
    { createdAt: post.createdAt, pumped: post.pumped, expiresAt: expiresAt(post.createdAt, post.pumped) },
    Date.now(),
  );
  if (r.status === "expired" && amount < r.requiredMinSol) {
    return NextResponse.json(
      {
        error: `Ce post est expiré. Il faut au moins ${formatSolFr(r.requiredMinSol)} SOL pour le sauver.`,
        code: "amount_too_low_to_save",
        ...r,
      },
      { status: 422 },
    );
  }
  return NextResponse.json({ ok: true, ...r });
}
