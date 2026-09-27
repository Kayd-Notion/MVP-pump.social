"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "./Avatar";
import { TimeGauge } from "./TimeGauge";
import { useUI } from "@/context/UIContext";
import { useSession } from "@/context/SessionContext";
import { fmtSol, timeAgo } from "@/lib/format";
import { postLifespanInfo } from "@/lib/lifespan";
import type { ClientPost } from "@/lib/client-types";

export function PostCard({ post }: { post: ClientPost }) {
  const router = useRouter();
  const { openPump, toast } = useUI();
  const { requireAuth } = useSession();
  const [liked, setLiked] = useState(false);
  const [reposted, setReposted] = useState(false);

  const expired = postLifespanInfo(post).expired;

  const go = () => router.push(`/post/${post.id}`);
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  const toggleLike = () => {
    if (!requireAuth("Connecte ton wallet pour aimer un post.")) return;
    setLiked((v) => !v);
  };
  const toggleRepost = () => {
    if (!requireAuth("Connecte ton wallet pour reposter.")) return;
    setReposted((v) => !v);
    toast(reposted ? "Repost annulé" : "🔁 Reposté");
  };
  const doPump = () => {
    if (!requireAuth("Connecte ton wallet pour pumper ce post.")) return;
    openPump(post);
  };

  return (
    <article className={`post${expired ? " expired" : ""}`} onClick={go}>
      <Avatar id={post.author.id} handle={post.author.handle} />
      <div className="post-body">
        <div className="post-head">
          <span className="name">{post.author.handle}</span>
          <span className="handle">@{post.author.handle}</span>
          <span className="dot-sep">·</span>
          <span className="time">{timeAgo(post.createdAt)}</span>
          {expired && (
            <span className="expired-tag" style={{ marginLeft: "auto" }}>
              Expiré
            </span>
          )}
        </div>
        <div className="post-text">{post.text}</div>

        {post.mediaUrl && (
          <div className={`post-media${post.mediaType === "video" ? " video" : ""}`}>
            {post.mediaType === "video" ? (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video src={post.mediaUrl} preload="metadata" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={post.mediaUrl} alt="" loading="lazy" />
            )}
          </div>
        )}

        <div className="post-meta">
          <TimeGauge createdAt={post.createdAt} pumped={post.pumped} expiresAt={post.expiresAt} />
          <div className="pumped-badge">
            <span className="pb-amount">⚡ {fmtSol(post.pumped)}</span>
            <span className="pb-label">SOL pumpés</span>
          </div>
        </div>

        <div className="post-actions" onClick={stop}>
          <button className={`pa-btn${liked ? " liked" : ""}`} onClick={toggleLike}>
            <span className="pa-ico">{liked ? "❤️" : "🤍"}</span>
            <span className="pa-count">{post.likes + (liked ? 1 : 0)}</span>
          </button>
          <button className="pa-btn" onClick={go}>
            <span className="pa-ico">💬</span>
            <span>{post.comments}</span>
          </button>
          <button className={`pa-btn${reposted ? " reposted" : ""}`} onClick={toggleRepost}>
            <span className="pa-ico">🔁</span>
            <span>{post.reposts + (reposted ? 1 : 0)}</span>
          </button>
          <button className="pa-btn" onClick={() => toast("🚩 Post signalé (modération — hors scope MVP)")}>
            <span className="pa-ico">🚩</span>
          </button>
          <button className="pump-btn" onClick={doPump}>
            ⚡ Pump
          </button>
        </div>
      </div>
    </article>
  );
}
