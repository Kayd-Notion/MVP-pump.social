"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { PostCard } from "@/components/PostCard";
import { Avatar } from "@/components/Avatar";
import { useSession } from "@/context/SessionContext";
import { useUI } from "@/context/UIContext";
import { api } from "@/lib/api";
import type { ClientPost } from "@/lib/client-types";

const TABS = [
  { key: "foryou", label: "Pour toi" },
  { key: "following", label: "Abonnements" },
  { key: "live", label: "Live 🔴" },
];

export default function FeedPage() {
  const { user, requireAuth } = useSession();
  const { openComposer, dataVersion } = useUI();
  const [tab, setTab] = useState("foryou");
  const [posts, setPosts] = useState<ClientPost[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setDone(false);
    try {
      const res = await api.feed(tab);
      setPosts(res.posts);
      setCursor(res.nextCursor);
      setDone(res.nextCursor === null);
    } catch {
      setPosts([]);
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    loadInitial();
  }, [loadInitial, dataVersion]);

  const loadMore = useCallback(async () => {
    if (loadingRef.current || done || cursor === null) return;
    loadingRef.current = true;
    try {
      const res = await api.feed(tab, cursor);
      setPosts((prev) => [...prev, ...res.posts]);
      setCursor(res.nextCursor);
      if (res.nextCursor === null) setDone(true);
    } finally {
      loadingRef.current = false;
    }
  }, [tab, cursor, done]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => entries[0].isIntersecting && loadMore(),
      { rootMargin: "400px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadMore]);

  const onComposer = () => {
    if (!requireAuth("Connecte ton wallet pour poster.")) return;
    openComposer();
  };

  return (
    <section>
      <div className="tabs">
        {TABS.map((t) => (
          <div
            key={t.key}
            className={`tab${tab === t.key ? " active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </div>
        ))}
      </div>

      {!user && (
        <div className="visitor-banner">
          <span style={{ fontSize: 26 }}>👋</span>
          <div className="vb-text">
            <b>Mode visiteur</b>
            Connecte ton wallet pour pumper, poster et suivre des créateurs.
          </div>
          <VisitorConnect />
        </div>
      )}

      <div className="composer-trigger">
        {user ? (
          <Avatar id={user.id} handle={user.handle} size="sm" />
        ) : (
          <div className="avatar sm" style={{ background: "#6366f1" }}>
            ?
          </div>
        )}
        <button className="ct-fake" onClick={onComposer}>
          Quoi de neuf à pumper ?
        </button>
      </div>

      <div>
        {loading ? (
          <div className="loading-state">
            <span className="spinner" style={{ color: "var(--accent)" }} /> Chargement du feed…
          </div>
        ) : posts.length === 0 ? (
          <div className="empty-state">
            <div className="ico">🌱</div>
            Aucun post ici pour l&apos;instant.
          </div>
        ) : (
          posts.map((p) => <PostCard key={p.id} post={p} />)
        )}
        <div ref={sentinel} />
        {done && posts.length > 0 && (
          <p className="faint" style={{ textAlign: "center", padding: 20, fontSize: 13 }}>
            Tu as tout vu ✨
          </p>
        )}
      </div>
    </section>
  );
}

function VisitorConnect() {
  const { openConnect } = useUI();
  return (
    <button
      className="btn btn-primary btn-sm"
      onClick={() => openConnect("Connecte ton wallet Solana pour rejoindre pump.social.")}
    >
      Connecter
    </button>
  );
}
