"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/context/SessionContext";
import { useUI } from "@/context/UIContext";
import { api } from "@/lib/api";
import { shortWallet } from "@/lib/format";

export default function SettingsPage() {
  const router = useRouter();
  const { user, setUser, logout } = useSession();
  const { theme, toggleTheme, toast, openConnect } = useUI();
  const [bio, setBio] = useState("");
  const [handle, setHandle] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user) {
      setBio(user.bio);
      setHandle(user.handle);
    }
  }, [user]);

  if (!user) {
    return (
      <div className="empty-state">
        <div className="ico">⚙️</div>
        <p>Connecte ton wallet pour accéder aux paramètres.</p>
        <button
          className="btn btn-primary"
          style={{ marginTop: 14 }}
          onClick={() => openConnect("Connecte ton wallet pour accéder aux paramètres.")}
        >
          Connecter
        </button>
      </div>
    );
  }

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.updateMe(api.capabilities.profileExtras ? { bio, handle } : { handle });
      setUser(res.user);
      toast("✅ Profil enregistré");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Enregistrement impossible.");
    } finally {
      setSaving(false);
    }
  };

  const setPrivacy = async (patch: { hidePumpHistory?: boolean; anonymizePumps?: boolean }) => {
    try {
      const res = await api.updateMe(patch);
      setUser(res.user);
      toast("Préférence mise à jour");
    } catch {
      toast("Mise à jour impossible.");
    }
  };

  return (
    <section>
      <div className="header back-bar" style={{ borderBottom: "1px solid var(--border-soft)" }}>
        <button className="back-btn" onClick={() => router.push("/profile")}>
          ←
        </button>
        <div className="page-title" style={{ display: "block" }}>
          Paramètres
        </div>
      </div>

      <div className="settings-group">
        <div className="sg-title">Profil</div>
        <div style={{ padding: "14px 16px" }}>
          <label className="field-label">Pseudo</label>
          <input className="field" value={handle} onChange={(e) => setHandle(e.target.value)} maxLength={20} />
        </div>
        <div style={{ padding: "0 16px 14px", display: api.capabilities.profileExtras ? "block" : "none" }}>
          <label className="field-label">Bio</label>
          <textarea
            className="field"
            rows={3}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={240}
            style={{ resize: "none" }}
          />
        </div>
        <div style={{ padding: "0 16px 16px" }}>
          <button className="btn btn-primary btn-block" onClick={save} disabled={saving}>
            {saving ? "Enregistrement…" : "Enregistrer"}
          </button>
        </div>
      </div>

      <div className="settings-group" style={{ display: api.capabilities.profileExtras ? "block" : "none" }}>
        <div className="sg-title">Confidentialité</div>
        <div className="settings-row">
          <div className="sr-text">
            Masquer mon historique de pump
            <small>Cache le total « pumps donnés » sur ton profil public</small>
          </div>
          <div
            className={`toggle${user.hidePumpHistory ? " on" : ""}`}
            onClick={() => setPrivacy({ hidePumpHistory: !user.hidePumpHistory })}
          >
            <span className="tg-switch" />
          </div>
        </div>
        <div className="settings-row">
          <div className="sr-text">
            Anonymiser mes pumps par défaut
            <small>Apparaître comme « Pumper anonyme » dans les historiques</small>
          </div>
          <div
            className={`toggle${user.anonymizePumps ? " on" : ""}`}
            onClick={() => setPrivacy({ anonymizePumps: !user.anonymizePumps })}
          >
            <span className="tg-switch" />
          </div>
        </div>
      </div>

      <div className="settings-group">
        <div className="sg-title">Apparence</div>
        <div className="settings-row">
          <div className="sr-text">Thème sombre</div>
          <div className={`toggle${theme === "dark" ? " on" : ""}`} onClick={toggleTheme}>
            <span className="tg-switch" />
          </div>
        </div>
      </div>

      <div className="settings-group">
        <div className="sg-title">Compte</div>
        <div className="settings-row" style={{ cursor: "pointer" }} onClick={() => logout()}>
          <div className="sr-text">
            Déconnecter le wallet
            <small>{shortWallet(user.wallet)}</small>
          </div>
          <span>🔓</span>
        </div>
      </div>
    </section>
  );
}
