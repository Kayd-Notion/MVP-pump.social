"use client";
import { useEffect, useState } from "react";
import { Modal } from "../Modal";
import { Avatar } from "../Avatar";
import { useUI } from "@/context/UIContext";
import { useSession } from "@/context/SessionContext";
import { usePump } from "@/hooks/usePump";
import { quotePump } from "@/lib/pump";
import { MIN_PUMP_SOL, resolvedSplitBps } from "@/lib/pump-config";
import { formatSolFr } from "@/lib/pump-rules";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/api-error";
import type { PumpQuote } from "@/lib/api-types";
import { fmtSol } from "@/lib/format";
import { IS_MAINNET } from "@/lib/solana";

const QUICK_AMOUNTS = [0.01, 0.1, 0.5, 1];
const EPS = 1e-9;

/** Reads the new minimum from a refusal body (standalone backend or Next routes). */
function minFromError(data: Record<string, unknown>): number | null {
  const v = data.required_min_sol ?? data.requiredMinSol;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function PumpModal() {
  const { pumpTarget, closeModal, toast, bumpData } = useUI();
  const { user } = useSession();
  const { runPump, canSign } = usePump();
  const [amount, setAmount] = useState(0.1);
  const [phase, setPhase] = useState<"form" | "sending" | "success">("form");
  const [split, setSplit] = useState(() => resolvedSplitBps());
  const [minPump, setMinPump] = useState(MIN_PUMP_SOL);
  // Rules for this post right now (null while loading).
  const [quote, setQuote] = useState<PumpQuote | null>(null);
  const [purgedAfterPump, setPurgedAfterPump] = useState(false);

  // Ratio + minimum the data source will actually enforce.
  useEffect(() => {
    api
      .pumpConfig()
      .then((c) => {
        setSplit({ creatorBps: c.creatorBps, founderBps: c.platformBps });
        setMinPump(c.minPumpSol);
      })
      .catch(() => {});
  }, []);

  // Rule 2: is the post still pumpable, and how much does it take?
  const postId = pumpTarget?.id;
  useEffect(() => {
    if (!postId) return;
    let cancelled = false;
    setQuote(null);
    api
      .pumpQuote(postId)
      .then((q) => {
        if (cancelled) return;
        setQuote(q);
        // Expired post: pre-select the amount that saves it.
        if (q.status === "expired") setAmount(q.requiredMinSol);
      })
      .catch((e) => {
        if (cancelled) return;
        // Post gone (404/409): treat as deleted; otherwise fall back to the
        // global minimum and let the server-side pre-check decide.
        const gone = e instanceof ApiError && (e.status === 404 || e.code === "post_deleted");
        setQuote({
          status: gone ? "deleted" : "active",
          minPumpSol: MIN_PUMP_SOL,
          minToSaveSol: null,
          requiredMinSol: MIN_PUMP_SOL,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [postId]);

  if (!pumpTarget) return null;
  const post = pumpTarget;
  const { creatorBps, founderBps } = split;
  const safeAmount = amount > 0 ? amount : 0;
  const q = quote;
  const expired = q?.status === "expired";
  const requiredMin = Math.max(minPump, q?.requiredMinSol ?? minPump);
  const tooLow = safeAmount + EPS < requiredMin;
  const quoteSplit = quotePump(safeAmount, founderBps);

  // Validation message under the amount (UI side of rules 2 + 3).
  let amountError: string | null = null;
  if (q && tooLow) {
    amountError = expired
      ? `Ce post est expiré. Il faut au moins ${formatSolFr(requiredMin)} SOL pour le sauver.`
      : `Minimum ${formatSolFr(minPump)} SOL`;
  }

  const confirm = async () => {
    if (!q || tooLow) return;
    if (!canSign) {
      toast("Reconnecte ton wallet pour signer la transaction.");
      return;
    }
    setPhase("sending");
    try {
      const { postPurged } = await runPump(post, safeAmount, user?.anonymizePumps ?? false);
      setPurgedAfterPump(postPurged);
      setPhase("success");
      bumpData();
      if (!postPurged) {
        setTimeout(() => {
          closeModal();
          toast(`⚡ +${fmtSol(safeAmount)} SOL pumpés`);
        }, 1200);
      }
    } catch (e) {
      setPhase("form");
      // Server refused right before signing (nothing was signed).
      if (e instanceof ApiError && e.code === "post_deleted") {
        setQuote({ ...q, status: "deleted" });
        return;
      }
      if (e instanceof ApiError && e.code === "amount_too_low_to_save") {
        const min = minFromError(e.data);
        if (min) {
          setQuote({ ...q, status: "expired", minToSaveSol: min, requiredMinSol: min });
          setAmount(min);
        }
      }
      toast(e instanceof Error ? e.message : "Le pump a échoué.");
    }
  };

  // --- Post purged: no pump possible ------------------------------------
  if (q?.status === "deleted") {
    return (
      <Modal title="⚡ Pump un post" onClose={closeModal}>
        <div className="empty-state" style={{ padding: "30px 10px" }}>
          <div className="ico">🗑️</div>
          <b style={{ color: "var(--text)" }}>Post supprimé</b>
          <p className="muted" style={{ marginTop: 6 }}>
            Ce post a expiré et a été supprimé : il ne peut plus être pumpé. Aucun SOL n&apos;a été envoyé.
          </p>
        </div>
        <button className="btn btn-block" onClick={closeModal}>
          Fermer
        </button>
      </Modal>
    );
  }

  return (
    <Modal title="⚡ Pump un post" onClose={closeModal}>
      {phase === "success" ? (
        <div className="pump-success">
          <div className="ps-ico">✓</div>
          <h3 style={{ fontSize: 19, marginBottom: 6 }}>Pump confirmé !</h3>
          {purgedAfterPump ? (
            <p className="muted">
              Ton pump de <b>{fmtSol(safeAmount)} SOL</b> est bien enregistré, mais le post venait d&apos;être
              supprimé. Ce cas est signalé pour un remboursement manuel.
            </p>
          ) : (
            <p className="muted">
              Tu as pumpé <b>{fmtSol(safeAmount)} SOL</b>.<br />
              Le post gagne en durée de vie. 🚀
            </p>
          )}
          {purgedAfterPump && (
            <button className="btn btn-block" style={{ marginTop: 16 }} onClick={closeModal}>
              Fermer
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="pump-target">
            <Avatar id={post.author.id} handle={post.author.handle} size="sm" />
            <div className="pt-text">
              Tu pumps le post de <b>{post.author.handle}</b>
              <br />« {post.text.slice(0, 60)}
              {post.text.length > 60 ? "…" : ""} »
            </div>
          </div>

          {IS_MAINNET && (
            <p className="muted" style={{ color: "var(--danger)", marginBottom: 12 }}>
              ⚠️ Les pumps sont désactivés sur mainnet (programme non audité).
            </p>
          )}

          {expired && (
            <div className="pump-notice">
              <p>
                <b>⏳ Ce post est expiré.</b> Il faut au moins <b>{formatSolFr(requiredMin)} SOL</b> pour le sauver
                (il sera supprimé sinon).
              </p>
              {tooLow && (
                <button className="btn btn-sm btn-accent-soft" style={{ marginTop: 8 }} onClick={() => setAmount(requiredMin)}>
                  Utiliser {formatSolFr(requiredMin)} SOL
                </button>
              )}
            </div>
          )}

          <label className="field-label">Montants rapides</label>
          <div className="quick-amounts">
            {QUICK_AMOUNTS.map((a) => (
              <button
                key={a}
                className={`qa-btn${a === amount ? " active" : ""}`}
                onClick={() => setAmount(a)}
                // Only an expired post's save minimum disables quick amounts
                // (they all start at 0.01, above MIN_PUMP_SOL).
                disabled={expired && a + EPS < requiredMin}
                title={expired && a + EPS < requiredMin ? "Insuffisant pour sauver ce post" : undefined}
              >
                {a}
              </button>
            ))}
          </div>

          <label className="field-label">Montant personnalisé (SOL)</label>
          <input
            className={`field${amountError ? " field-invalid" : ""}`}
            type="number"
            step="0.001"
            min={requiredMin}
            value={amount}
            onChange={(e) => setAmount(parseFloat(e.target.value) || 0)}
            aria-invalid={Boolean(amountError)}
          />
          {amountError && <p className="field-error">{amountError}</p>}

          <div className="split-box">
            <div className="split-row creator">
              <span>👤 Créateur ({creatorBps / 100}%)</span>
              <b>{fmtSol(quoteSplit.creatorSol)} SOL</b>
            </div>
            <div className="split-row">
              <span>🏦 Plateforme ({founderBps / 100}%)</span>
              <b>{fmtSol(quoteSplit.founderSol)} SOL</b>
            </div>
            <div className="split-bar">
              <div className="s-creator" style={{ width: `${creatorBps / 100}%` }} />
              <div className="s-pool" style={{ width: `${founderBps / 100}%` }} />
            </div>
            <div
              className="split-row"
              style={{ borderTop: "1px solid var(--border-soft)", marginTop: 6, paddingTop: 8 }}
            >
              <span>Total</span>
              <b>{fmtSol(safeAmount)} SOL</b>
            </div>
          </div>

          <button
            className="btn btn-primary btn-block"
            onClick={confirm}
            disabled={!q || tooLow || phase === "sending" || IS_MAINNET}
          >
            {!q ? (
              <>
                <span className="spinner" /> Vérification du post…
              </>
            ) : phase === "sending" ? (
              <>
                <span className="spinner" /> Signature en cours…
              </>
            ) : (
              `⚡ Confirmer le pump de ${formatSolFr(safeAmount)} SOL`
            )}
          </button>
          <button
            className="btn btn-ghost btn-block"
            style={{ marginTop: 8 }}
            onClick={closeModal}
            disabled={phase === "sending"}
          >
            Annuler
          </button>
        </>
      )}
    </Modal>
  );
}
