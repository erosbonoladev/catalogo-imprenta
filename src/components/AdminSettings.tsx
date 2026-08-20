import { useState, type FormEvent } from "react";
import { setSectionPassword } from "../db";
import { SECCION_IMPRENTA, SECCION_PLASTICOS } from "../types";
import Toast from "./Toast";

interface Props {
  onBack: () => void;
}

export default function AdminSettings({ onBack }: Props) {
  return (
    <div className="private-section">
      <button className="btn-link" onClick={onBack}>
        ← Volver al menú principal
      </button>
      <h1>Contraseñas</h1>
      <p className="hint">
        Cambia aquí las contraseñas de las secciones privadas de cada ficha técnica.
      </p>

      <SectionPasswordForm section={SECCION_PLASTICOS} label="Plásticos" />
      <SectionPasswordForm section={SECCION_IMPRENTA} label="Imprenta" />
    </div>
  );
}

function SectionPasswordForm({ section, label }: { section: string; label: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showToast, setShowToast] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = password.length > 0 || confirm.length > 0;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 4) {
      setError("La contraseña debe tener al menos 4 caracteres.");
      return;
    }
    if (password !== confirm) {
      setError("Las contraseñas no coinciden.");
      return;
    }

    setBusy(true);
    try {
      await setSectionPassword(section, password);
      setShowToast(true);
      setPassword("");
      setConfirm("");
    } catch (err) {
      setError(`No se pudo guardar: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="admin-password-form" onSubmit={handleSubmit}>
      <h2>{label}</h2>
      <div className="form-row">
        <label>
          Nueva contraseña
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label>
          Confirmar
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy || !dirty}>
          {busy ? "Guardando…" : `Cambiar contraseña de ${label}`}
        </button>
      </div>
      <Toast message="Guardado con éxito" show={showToast} onHide={() => setShowToast(false)} />
    </form>
  );
}
