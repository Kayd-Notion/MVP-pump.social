"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/Avatar";
import { api } from "@/lib/api";
import { useUI } from "@/context/UIContext";
import { KNOWN_COUNTRIES } from "@/lib/geo-client";
import { fmtSol } from "@/lib/format";
import type {
  LeaderboardCreatorItem,
  LeaderboardPeriod,
  LeaderboardPostItem,
} from "@/lib/client-types";

const PERIODS: { key: LeaderboardPeriod; label: string; short: string }[] = [
  { key: "all", label: "Tout", short: "" },
  { key: "24h", label: "24h", short: "24h" },
  { key: "7d", label: "7 jours", short: "7 j" },
  { key: "30d", label: "30 jours", short: "30 j" },
];

export default function LeaderboardPage() {
  const router = useRouter();
  const { dataVersion } = useUI();
  const [kind, setKind] = useState<"posts" | "creators">("posts");
  const [scope, setScope] = useState<"world" | "country">("world");
  const [period, setPeriod] = useState<LeaderboardPeriod>("all");
  const [country, setCountry] = useState("FR");
  const [posts, setPosts] = useState<LeaderboardPostItem[]>([]);
  const [creators, setCreators] = useState<LeaderboardCreatorItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const sentinel = useRef<HTMLDivElement>(null);
  const loadingMore = useRef(false);
  // Incremented on every filter change: responses from an older request are dropped.
  const reqSeq = useRef(0);

  // Default the country selector to the viewer's IP-derived country.
  useEffect(() => {
    api.geo().then((r) => setCountry(r.country)).catch(() => {});
  }, []);

  const params = useCallback(
    (c: string | null) => ({
      scope,
      period,
      country: scope === "country" ? country : undefined,
      cursor: c,
    }),
    [scope, period, country],
  );

  const reload = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      if (kind === "posts") {
        const res = await api.leaderboard({ kind: "posts", ...params(null) });
        if (seq !== reqSeq.current) return;
        setPosts(res.items);
        setCursor(res.nextCursor);
      } else {
        const res = await api.leaderboard({ kind: "creators", ...params(null) });
        if (seq !== reqSeq.current) return;
        setCreators(res.items);
        setCursor(res.nextCursor);
      }
    } catch {
      if (seq !== reqSeq.current) return;
      setPosts([]);
      setCreators([]);
      setCursor(null);
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [kind, params]);

  useEffect(() => {
    reload();
  }, [reload, dataVersion]);

  const loadMore = useCallback(async () => {
    if (loadingMore.current || loading || !cursor) return;
    loadingMore.current = true;
    const seq = reqSeq.current;
    try {
      if (kind === "posts") {
        const res = await api.leaderboard({ kind: "posts", ...params(cursor) });
        if (seq !== reqSeq.current) return;
        setPosts((prev) => [...prev, ...res.items]);
        setCursor(res.nextCursor);
      } else {
        const res = await api.leaderboard({ kind: "creators", ...params(cursor) });
        if (seq !== reqSeq.current) return;
        setCreators((prev) => [...prev, ...res.items]);
        setCursor(res.nextCursor);
      }
    } finally {
      loadingMore.current = false;
    }
  }, [kind, params, cursor, loading]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (e) => e[0].isIntersecting && loadMore(),
      { rootMargin: "400px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadMore]);

  const short = PERIODS.find((p) => p.key === period)!.short;
  const empty = kind === "posts" ? posts.length === 0 : creators.length === 0;

  return (
    <section>
      <div className="tabs">
        <div className={`tab${kind === "posts" ? " active" : ""}`} onClick={() => setKind("posts")}>
          Posts
        </div>
        <div className={`tab${kind === "creators" ? " active" : ""}`} onClick={() => setKind("creators")}>
          Créateurs
        </div>
      </div>

      <div className="lb-controls">
        <div className="lb-filters">
          <div className="seg">
            <button className={`chip${scope === "world" ? " active" : ""}`} onClick={() => setScope("world")}>
              🌍 Mondial
            </button>
            <button className={`chip${scope === "country" ? " active" : ""}`} onClick={() => setScope("country")}>
              📍 Par pays
            </button>
          </div>
          <div className="seg" role="group" aria-label="Période">
            {PERIODS.map((p) => (
              <button
                key={p.key}
                className={`chip${period === p.key ? " active" : ""}`}
                onClick={() => setPeriod(p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        {scope === "country" && (
          <select className="field" value={country} onChange={(e) => setCountry(e.target.value)}>
            {[...KNOWN_COUNTRIES].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
      </div>

      {loading ? (
        <div className="loading-state">
          <span className="spinner" style={{ color: "var(--accent)" }} /> Chargement…
        </div>
      ) : empty ? (
        <div className="empty-state">
          <div className="ico">🏆</div>
          {period === "all" ? "Aucune entrée pour ce filtre." : "Aucun pump sur cette période."}
        </div>
      ) : kind === "posts" ? (
        posts.map((it, i) => {
          const author = it.post?.author ?? it.creator;
          return (
            <div
              key={it.postId}
              className={`lb-row${i < 3 ? " top" + (i + 1) : ""}`}
              onClick={() =>
                it.post
                  ? router.push(`/post/${it.postId}`)
                  : author && router.push(`/profile/${author.handle}`)
              }
            >
              <div className="lb-rank">{i + 1}</div>
              {author ? (
                <Avatar id={author.id} handle={author.handle} size="sm" />
              ) : (
                <Avatar id={it.postId} handle="?" size="sm" anonymous />
              )}
              <div className="lb-info">
                {it.post ? (
                  <div className="lb-name">
                    {it.post.text.slice(0, 42)}
                    {it.post.text.length > 42 ? "…" : ""}
                  </div>
                ) : (
                  <div className="lb-name faint" style={{ fontStyle: "italic", fontWeight: 600 }}>
                    Post supprimé
                  </div>
                )}
                <div className="lb-sub">
                  {author ? `${author.handle} · @${author.handle}` : "Créateur inconnu"}
                </div>
              </div>
              <div className="lb-amount">
                ⚡ {fmtSol(it.total)}
                <small>{short ? `SOL · ${short}` : "SOL"}</small>
              </div>
            </div>
          );
        })
      ) : (
        creators.map(({ user: u, total }, i) => (
          <div
            key={u.id}
            className={`lb-row${i < 3 ? " top" + (i + 1) : ""}`}
            onClick={() => router.push(`/profile/${u.handle}`)}
          >
            <div className="lb-rank">{i + 1}</div>
            <Avatar id={u.id} handle={u.handle} size="sm" />
            <div className="lb-info">
              <div className="lb-name">{u.handle}</div>
              <div className="lb-sub">@{u.handle}</div>
            </div>
            <div className="lb-amount">
              ⚡ {fmtSol(total)}
              <small>{short ? `reçus · ${short}` : "reçus"}</small>
            </div>
          </div>
        ))
      )}
      <div ref={sentinel} />
    </section>
  );
}
