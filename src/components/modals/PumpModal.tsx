"use client";
import { useEffect, useState } from "react";
import { Modal } from "../Modal";
import { Avatar } from "../Avatar";
import { useUI } from "@/context/UIContext";
import { useSession } from "@/context/SessionContext";
import { usePump } from "@/hooks/usePump";
import { quotePump } from "@/lib/pump";
import { resolvedSplitBps } from "@/lib/pump-config";
import { api } from "@/lib/api";
import { fmtSol } from "@/lib/format";
import { IS_MAINNET } from "@/lib/solana";

const QUICK_AMOUNTS = [0.01, 0.1, 0.5, 1];

export function PumpModal() {
  const { pumpTarget, closeModal, toast, bumpData } = useUI();
  const { user } = useSession();
  const { runPump, canSign } = usePump();
  const [amount, setAmount] = useState(0.1);
  const [phase, setPhase] = useState<"form" | "sending" | "success">("form");
  const [split, setSplit] = useState(() => resolvedSplitBps());

  // Show the ratio the data source will actually enforce.
  useEffect(() => {
    api
      .pumpConfig()
      .then((c) => setSplit({ creatorBps: c.creatorBps, founderBps: c.platformBps }))
      .catch(() => {});
  }, []);

  if (!pumpTarget) return null;
  const post = pumpTarget;
  const { creatorBps, founderBps } = split;
  const quote = quotePump(amount > 0 ? amount : 0, founderBps);

  const confirm = async () => {
    if (amount <= 0) return;
    if (!canSign) {
      toast("Reconnecte ton wallet pour signer la transaction.");
      return;
    }
    setPhase("sending");
    try {
      await runPump(post, amount, user?.anonymizePumps ?? false);
      setPhase("success");
      bumpData();
      setTimeout(() => {
        closeModal();
        toast(`⚡ +${fmtSol(amount)} SOL pumpés`);
      }, 1200);
    } catch (e) {
      setPhase("form");
      toast(e instanceof Error ? e.message : "Le pump a échoué.");
    }
  };

  return (
    <Modal title="⚡ Pump un post" onClose={closeModal}>
      {phase === "success" ? (
        <div className="pump-success">
          <div className="ps-ico">✓</div>
          <h3 style={{ fontSize: 19, marginBottom: 6 }}>Pump confirmé !</h3>
          <p className="muted">
            Tu as pumpé <b>{fmtSol(amount)} SOL</b>.<br />
            Le post gagne en durée de vie. 🚀
          </p>
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

          <label className="field-label">Montants rapides</label>
          <div className="quick-amounts">
            {QUICK_AMOUNTS.map((a) => (
              <button
                key={a}
                className={`qa-btn${a === amount ? " active" : ""}`}
                onClick={() => setAmount(a)}
              >
                {a}
              </button>
            ))}
          </div>

          <label className="field-label">Montant personnalisé (SOL)</label>
          <input
            className="field"
            type="number"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(parseFloat(e.target.value) || 0)}
          />

          <div className="split-box">
            <div className="split-row creator">
              <span>👤 Créateur ({creatorBps / 100}%)</span>
              <b>{fmtSol(quote.creatorSol)} SOL</b>
            </div>
            <div className="split-row">
              <span>🏦 Plateforme ({founderBps / 100}%)</span>
              <b>{fmtSol(quote.founderSol)} SOL</b>
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
              <b>{fmtSol(amount > 0 ? amount : 0)} SOL</b>
            </div>
          </div>

          <button
            className="btn btn-primary btn-block"
            onClick={confirm}
            disabled={amount <= 0 || phase === "sending" || IS_MAINNET}
          >
            {phase === "sending" ? (
              <>
                <span className="spinner" /> Signature en cours…
              </>
            ) : (
              `⚡ Confirmer le pump de ${fmtSol(amount > 0 ? amount : 0)} SOL`
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
