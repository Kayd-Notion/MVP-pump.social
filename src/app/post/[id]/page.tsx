"use client";
import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/Avatar";
import { TimeGauge } from "@/components/TimeGauge";
import { useSession } from "@/context/SessionContext";
import { useUI } from "@/context/UIContext";
import { api } from "@/lib/api";
import { fmtSol, timeAgo } from "@/lib/format";
import { postLifespanInfo } from "@/lib/lifespan";
import type { ClientComment, ClientPost, ClientPumper } from "@/lib/client-types";

export default function PostDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { requireAuth } = useSession();
  const { openPump, toast, dataVersion } = useUI();

  const [post, setPost] = useState<ClientPost | null>(null);
  const [pumpers, setPumpers] = useState<ClientPumper[]>([]);
  const [comments, setComments] = useState<ClientComment[]>([]);
  const [anon, setAnon] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.post(id);
      setPost(res.post);
      setPumpers(res.pumpers);
      setComments(res.comments);
    } catch {
      setNotFound(true);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load, dataVersion]);

  if (notFound) {
    return (
      <div className="empty-state">
        <div className="ico">🔍</div>
        Post introuvable.
      </div>
    );
  }
  if (!post) {
    return (
      <div className="loading-state">
        <span className="spinner" style={{ color: "var(--accent)" }} /> Chargement…
      </div>
    );
  }

  const expired = postLifespanInfo(post).expired;

  const submitComment = async () => {
    if (!requireAuth("Connecte ton wallet pour commenter.")) return;
    const v = commentText.trim();
    if (!v) return;
    try {
      const res = await api.addComment(post.id, v);
      setComments(res.comments);
      setCommentText("");
      setPost({ ...post, comments: post.comments + 1 });
      toast("💬 Commentaire ajouté");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Envoi impossible.");
    }
  };

  const doPump = () => {
    if (!requireAuth("Connecte ton wallet pour pumper ce post.")) return;
    openPump(post);
  };

  return (
    <section>
      <div className="header back-bar" style={{ borderBottom: "1px solid var(--border-soft)" }}>
        <button className="back-btn" onClick={() => router.push("/")}>
          ←
        </button>
        <div className="page-title" style={{ display: "block" }}>
          Post
        </div>
      </div>

      <div className="detail-post">
        <div className="dp-head">
          <Avatar id={post.author.id} handle={post.author.handle} />
          <div style={{ cursor: "pointer" }} onClick={() => router.push(`/profile/${post.author.handle}`)}>
            <div className="name" style={{ fontWeight: 700 }}>
              {post.author.handle}
            </div>
            <div className="handle faint">
              @{post.author.handle} · {timeAgo(post.createdAt)}
            </div>
          </div>
          {expired && (
            <span className="expired-tag" style={{ marginLeft: "auto" }}>
              Expiré
            </span>
          )}
        </div>

        {post.deleted ? (
          <div className="dp-text faint" style={{ fontStyle: "italic" }}>
            Ce post a expiré et son contenu a été supprimé.
          </div>
        ) : (
          <div className="dp-text">{post.text}</div>
        )}

        {post.mediaUrl && (
          <div className={`post-media${post.mediaType === "video" ? " video" : ""}`}>
            {post.mediaType === "video" ? (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video src={post.mediaUrl} controls />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={post.mediaUrl} alt="" />
            )}
          </div>
        )}

        <div className="post-meta" style={{ marginTop: 12 }}>
          <TimeGauge createdAt={post.createdAt} pumped={post.pumped} expiresAt={post.expiresAt} />
          <div className="pumped-badge">
            <span className="pb-amount">⚡ {fmtSol(post.pumped)}</span>
            <span className="pb-label">SOL pumpés</span>
          </div>
        </div>

        <div className="detail-stats">
          <span className="ds">
            <b>{post.reposts}</b> <span className="faint">reposts</span>
          </span>
          <span className="ds">
            <b>{post.likes}</b> <span className="faint">likes</span>
          </span>
          <span className="ds">
            <b>{post.comments}</b> <span className="faint">commentaires</span>
          </span>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="pump-btn"
            style={{ flex: 1, padding: 11, opacity: post.deleted ? 0.5 : 1 }}
            onClick={doPump}
            disabled={post.deleted}
          >
            ⚡ Pump ce post
          </button>
          <button className="btn" onClick={() => toast("🚩 Signalé (modération — hors scope MVP)")}>
            🚩
          </button>
        </div>
      </div>

      {/* Pumpers */}
      <div className="pumpers-head">
        <h4>⚡ Pumpers ({pumpers.length})</h4>
        <div className={`toggle${anon ? " on" : ""}`} onClick={() => setAnon((v) => !v)}>
          <span className="tg-switch" /> Anonymiser
        </div>
      </div>
      {pumpers.length === 0 && (
        <p className="faint" style={{ padding: "4px 16px 12px", fontSize: 13 }}>
          Aucun pump pour l&apos;instant — sois le premier ⚡
        </p>
      )}
      {pumpers.map((pp, i) => {
        const masked = anon || pp.anonymous || !pp.author;
        const name = masked ? `Pumper #${i + 1}` : pp.author!.handle;
        const sub = masked ? "•••••••" : `${pp.author!.wallet} · ${timeAgo(pp.createdAt)}`;
        return (
          <div className="pumper-row" key={pp.id}>
            {masked ? (
              <Avatar id={pp.id} handle="?" size="sm" anonymous />
            ) : (
              <Avatar id={pp.author!.handle} handle={pp.author!.handle} size="sm" />
            )}
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{name}</div>
              <div className="faint" style={{ fontSize: 12 }}>
                {sub}
              </div>
            </div>
            <span className="pr-amount">⚡ {fmtSol(pp.amount)}</span>
          </div>
        );
      })}

      {/* Comments */}
      <div className="section-title">Commentaires</div>
      {!api.capabilities.comments && (
        <p className="faint" style={{ padding: "0 16px 16px", fontSize: 13 }}>
          Les commentaires arrivent bientôt.
        </p>
      )}
      <div
        style={{ padding: "0 16px 12px", display: api.capabilities.comments ? "flex" : "none", gap: 10 }}
      >
        <input
          className="field"
          value={commentText}
          onChange={(e) => setCommentText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submitComment()}
          placeholder="Ajouter un commentaire…"
          maxLength={300}
        />
        <button className="btn btn-primary" onClick={submitComment}>
          Envoyer
        </button>
      </div>
      {comments.map((c) => (
        <div className="comment" key={c.id}>
          <Avatar id={c.author.id} handle={c.author.handle} size="sm" />
          <div className="c-body">
            <div className="c-head">
              <span className="name">{c.author.handle}</span>
              <span className="faint">
                @{c.author.handle} · {timeAgo(c.createdAt)}
              </span>
            </div>
            <div className="c-text">{c.text}</div>
          </div>
        </div>
      ))}
    </section>
  );
}
