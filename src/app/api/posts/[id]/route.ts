import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { shortWallet } from "@/lib/format";

export const runtime = "nodejs";

/** Post detail: the post, its pumpers (privacy-masked), and comments. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const store = getStore();
  const post = await store.getPost(id);
  if (!post) return NextResponse.json({ error: "Post introuvable." }, { status: 404 });

  const [pumpersRaw, comments] = await Promise.all([
    store.listPumpers(id),
    store.listComments(id),
  ]);

  // Privacy: for anonymous pumps, never leak the author — mask server-side.
  // Rule 1: flag self-pumps (pumper = post creator) for the "auto-pump" badge.
  // Kept visible even on anonymous pumps: it's about how the SOL moved, and
  // hiding it would let creators mask self-pumping behind anonymity.
  const pumpers = pumpersRaw.map((p, i) => {
    const isSelfPump = p.pumperUserId === post.userId;
    if (p.anonymous) {
      return {
        id: p.id,
        amount: p.amount,
        createdAt: p.createdAt,
        anonymous: true,
        isSelfPump,
        label: `Pumper #${i + 1}`,
        author: null as null,
      };
    }
    return {
      id: p.id,
      amount: p.amount,
      createdAt: p.createdAt,
      anonymous: false,
      isSelfPump,
      label: p.author.handle,
      author: { handle: p.author.handle, wallet: shortWallet(p.author.wallet) },
    };
  });

  return NextResponse.json({ post, pumpers, comments });
}
