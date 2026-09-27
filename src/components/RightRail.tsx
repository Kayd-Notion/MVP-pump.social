"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "./Avatar";
import { api } from "@/lib/api";
import { useUI } from "@/context/UIContext";
import { fmtSol } from "@/lib/format";
import type { LeaderboardCreatorItem } from "@/lib/client-types";

const TRENDS = [
  { tag: "#solana", count: "12.4k posts" },
  { tag: "#pump", count: "8.9k posts" },
  { tag: "#nft", count: "5.1k posts" },
  { tag: "#build", count: "3.3k posts" },
];

export function RightRail() {
  const router = useRouter();
  const { dataVersion } = useUI();
  const [creators, setCreators] = useState<LeaderboardCreatorItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .leaderboard({ kind: "creators", scope: "world", period: "all", limit: 3 })
      .then((res) => {
        if (!cancelled) setCreators(res.items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  return (
    <aside className="right-rail">
      <div className="rail-card">
        <h4>🏆 Top créateurs</h4>
        {creators.map(({ user: u, total }, i) => (
          <div
            key={u.id}
            className="lb-row"
            style={{ padding: "8px 0", border: "none" }}
            onClick={() => router.push(`/profile/${u.handle}`)}
          >
            <div className="lb-rank" style={{ width: 20, fontSize: 14 }}>
              {i + 1}
            </div>
            <Avatar id={u.id} handle={u.handle} size="sm" />
            <div className="lb-info">
              <div className="lb-name" style={{ fontSize: 13.5 }}>
                {u.handle}
              </div>
              <div className="lb-sub">@{u.handle}</div>
            </div>
            <div className="lb-amount" style={{ fontSize: 13 }}>
              ⚡{fmtSol(total)}
            </div>
          </div>
        ))}
      </div>
      <div className="rail-card">
        <h4>🔥 Tendances</h4>
        {TRENDS.map((t) => (
          <div
            key={t.tag}
            style={{ padding: "6px 0", cursor: "pointer" }}
            onClick={() => router.push(`/explore?q=${encodeURIComponent(t.tag)}`)}
          >
            <div style={{ fontWeight: 700, fontSize: 14 }}>{t.tag}</div>
            <div className="faint" style={{ fontSize: 12 }}>
              {t.count}
            </div>
          </div>
        ))}
      </div>
      <p className="faint" style={{ fontSize: 12, padding: "0 4px" }}>
        Réseau : devnet (aucune transaction sur mainnet). © pump.social
      </p>
    </aside>
  );
}
