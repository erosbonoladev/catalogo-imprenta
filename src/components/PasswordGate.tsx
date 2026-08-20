import { useEffect, useState, type FormEvent } from "react";
import {
  checkSectionPassword,
  getSectionPasswordHash,
  setSectionPassword,
} from "../db";

interface Props {
  section: string;
  onUnlock: () => void;
  onCancel: () => void;
}

export default function PasswordGate({ section, onUnlock, onCancel }: Props) {
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getSectionPasswordHash(section).then((hash) => setHasPassword(!!hash));
  }, [section]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    try {
      if (hasPassword) {
        setBusy(true);
        const ok = await checkSectionPassword(section, password);
        setBusy(false);
        if (!ok) {
          setError("Contraseña incorrecta.");
          return;
        }
        onUnlock();
      } else {
        if (password.length < 4) {
          setError("La contraseña debe tener al menos 4 caracteres.");
          return;
        }
        if (password !== confirm) {
          setError("Las contraseñas no coinciden.");
          return;
        }
        setBusy(true);
        await setSectionPassword(section, password);
        setBusy(false);
        onUnlock();
      }
    } catch (err) {
      setBusy(false);
      setError(`Ocurrió un problema al verificar la contraseña: ${String(err)}`);
    }
  }

  if (hasPassword === null) {
    return null;
  }

  return (
    <div className="password-gate">
      <h1>Información privada</h1>
      <p className="hint">
        {hasPassword
          ? "Esta sección tiene información privada. Ingresa la contraseña para continuar."
          : "Aún no se ha creado una contraseña para esta información privada. Créala ahora — la va a pedir cada vez que alguien quiera ver esta sección."}
      </p>

      <form onSubmit={handleSubmit}>
        <label>
          {hasPassword ? "Contraseña" : "Nueva contraseña"}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
        </label>

        {!hasPassword && (
          <label>
            Confirmar contraseña
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
        )}

        {error && <p className="form-error">{error}</p>}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {hasPassword ? "Desbloquear" : "Crear contraseña"}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancelar
          </button>
        </div>
      </form>
    </div>
  );
}
