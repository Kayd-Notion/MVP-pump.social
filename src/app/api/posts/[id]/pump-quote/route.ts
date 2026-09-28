import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { expiresAt } from "@/lib/lifespan";
import { pumpRequirements } from "@/lib/pump-rules";
import { PUMP_QUOTE_SLACK_SECONDS } from "@/lib/pump-config";

export const runtime = "nodejs";

/** Pump rules for this post right now (rule 2 + 3), shown in the pump modal. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const post = await getStore().getPost(id);
  if (!post) return NextResponse.json({ error: "Post introuvable.", code: "post_not_found" }, { status: 404 });
  const r = pumpRequirements(
    { createdAt: post.createdAt, pumped: post.pumped, expiresAt: expiresAt(post.createdAt, post.pumped) },
    Date.now(),
    PUMP_QUOTE_SLACK_SECONDS,
  );
  return NextResponse.json(r);
}
