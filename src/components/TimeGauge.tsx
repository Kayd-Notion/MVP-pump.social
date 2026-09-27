"use client";
import { useEffect, useState } from "react";
import { postLifespanInfo } from "@/lib/lifespan";
import { remainingLabel } from "@/lib/format";

/** Live-updating lifespan gauge (recomputes each minute). */
export function TimeGauge({
  createdAt,
  pumped,
  expiresAt,
}: {
  createdAt: number;
  pumped: number;
  expiresAt?: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const info = postLifespanInfo({ createdAt, pumped, expiresAt }, now);
  return (
    <div className="time-gauge">
      <div className="tg-labels">
        <span>Durée de vie</span>
        <span className="tg-remaining">{remainingLabel(info.remainingMs)}</span>
      </div>
      <div className="tg-bar">
        <div className={`tg-fill ${info.cls}`.trim()} style={{ width: `${info.pct}%` }} />
      </div>
    </div>
  );
}
