"use client";
import { useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Modal } from "../Modal";
import { Avatar } from "../Avatar";
import { useUI } from "@/context/UIContext";
import { useSession } from "@/context/SessionContext";
import { usePump } from "@/hooks/usePump";
import { api } from "@/lib/api";
import { mediaTypeOf } from "@/lib/irys";
import type { UploadedMedia } from "@/lib/api-types";

export function ComposerModal() {
  const { closeModal, toast, bumpData } = useUI();
  const { user } = useSession();
  const { wallet } = useWallet();
  const { runPump, canSign } = usePump();
  const fileInput = useRef<HTMLInputElement>(null);

  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [withPump, setWithPump] = useState(false);
  const [pumpAmount, setPumpAmount] = useState("0.1");
  const [phase, setPhase] = useState<"idle" | "uploading" | "posting" | "pumping">("idle");

  if (!user) return null;
  const busy = phase !== "idle";

  const pickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    if (!f) return;
    if (!mediaTypeOf(f)) {
      toast("Formats acceptés : image ou vidéo.");
      return;
    }
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };

  const submit = async () => {
    const body = text.trim();
    if (!body) {
      toast("Écris quelque chose 🙂");
      return;
    }
    try {
      let media: UploadedMedia | null = null;
      if (file) {
        // Irys needs the wallet to pay in SOL; the standalone backend uses a
        // presigned upload tied to the session instead.
        if (api.mode === "next" && !wallet?.adapter) {
          toast("Reconnecte ton wallet pour uploader le média.");
          return;
        }
        setPhase("uploading");
        media = await api.uploadMedia(file, wallet?.adapter);
      }

      setPhase("posting");
      const { post } = await api.createPost({ text: body, media });

      // Optional initial pump to boost the fresh post.
      const initial = withPump ? parseFloat(pumpAmount) || 0 : 0;
      if (initial > 0) {
        if (!canSign) {
          toast("Post publié — reconnecte ton wallet pour le pump initial.");
        } else {
          setPhase("pumping");
          try {
            await runPump(post, initial, user.anonymizePumps);
          } catch (e) {
            toast(e instanceof Error ? e.message : "Pump initial échoué (post publié).");
          }
        }
      }

      bumpData();
      closeModal();
      toast("✅ Post publié !");
      setText("");
      setFile(null);
      setPreview(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Publication impossible.");
    } finally {
      setPhase("idle");
    }
  };

  const phaseLabel =
    phase === "uploading"
      ? api.mode === "next"
        ? "Upload du média sur Arweave…"
        : "Upload du média…"
      : phase === "posting"
        ? "Publication…"
        : phase === "pumping"
          ? "Pump initial…"
          : "Publier";

  return (
    <Modal title="Nouveau post" onClose={closeModal}>
      <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
        <Avatar id={user.id} handle={user.handle} size="sm" />
        <textarea
          className="field"
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Quoi de neuf à pumper ?"
          maxLength={500}
          style={{ resize: "none", border: "none", background: "transparent", fontSize: 17, padding: "8px 0" }}
          autoFocus
        />
      </div>

      {preview && (
        <div className={`post-media${file && mediaTypeOf(file) === "video" ? " video" : ""}`} style={{ marginBottom: 12 }}>
          {file && mediaTypeOf(file) === "video" ? (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video src={preview} />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="" />
          )}
          <button
            className="media-tag"
            style={{ right: 8, left: "auto", cursor: "pointer" }}
            onClick={() => {
              setFile(null);
              setPreview(null);
            }}
          >
            ✕ Retirer
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          ref={fileInput}
          type="file"
          accept="image/*,video/*"
          hidden
          onChange={pickFile}
        />
        <button className="btn btn-sm" onClick={() => fileInput.current?.click()} disabled={busy}>
          📷 Photo / 🎬 Vidéo
        </button>
        <span className="faint" style={{ fontSize: 12, alignSelf: "center" }}>
          {api.mode === "next" ? "Upload Arweave payé en SOL" : "Upload direct (max 25 Mo)"}
        </span>
      </div>

      <label className={`toggle${withPump ? " on" : ""}`} onClick={() => setWithPump((v) => !v)}>
        <span className="tg-switch" /> Ajouter un pump initial pour booster mon post
      </label>
      {withPump && (
        <div style={{ marginTop: 12 }}>
          <label className="field-label">Montant initial (SOL)</label>
          <input
            className="field"
            type="number"
            step="0.01"
            min="0"
            value={pumpAmount}
            onChange={(e) => setPumpAmount(e.target.value)}
          />
        </div>
      )}

      <button
        className="btn btn-primary btn-block"
        style={{ marginTop: 18 }}
        onClick={submit}
        disabled={busy}
      >
        {busy ? (
          <>
            <span className="spinner" /> {phaseLabel}
          </>
        ) : (
          "Publier"
        )}
      </button>
    </Modal>
  );
}
