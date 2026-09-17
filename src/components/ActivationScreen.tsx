import { useState, type FormEvent } from "react";
import { useActivation } from "../activationContext";
import clioLogo from "../../Assets/clio.png";

// Mismo look que LoginScreen (login-card/login-input/form-actions) — este
// gate corre antes que el login de usuario, ver activationContext.tsx.
export default function ActivationScreen() {
  const { status, errorMessage, activate } = useActivation();
  const [codigo, setCodigo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const result = await activate(codigo.trim());
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? "No se pudo activar la instalación.");
    }
  }

  const blocked = status === "revoked" || status === "error";

  return (
    <div className="login-card">
      <div className="login-header">
        <div className="icon-badge login-header-icon">
          <img src={clioLogo} alt="Clio" />
        </div>
      </div>

      {blocked ? (
        <p className="form-error login-error" role="alert">
          {errorMessage}
        </p>
      ) : (
        <form onSubmit={handleSubmit} className={busy ? "login-form-busy" : undefined}>
          <p className="hint" style={{ marginBottom: "0.75rem" }}>
            Esta instalación todavía no está activada. Introduce tu credencial de activación
            (proporcionada por un administrador) para continuar.
          </p>
          <p className="hint" style={{ marginBottom: "0.75rem" }}>
            Tu sistema puede pedirte confirmar el acceso al llavero de contraseñas para guardar la
            credencial de forma segura — es normal, elegí "Permitir siempre".
          </p>
          <input
            type="text"
            className="login-input"
            placeholder="Código de activación"
            aria-label="Código de activación"
            value={codigo}
            onChange={(e) => setCodigo(e.target.value)}
            autoFocus
            disabled={busy}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />

          {error && (
            <p className="form-error login-error" role="alert">
              {error}
            </p>
          )}

          <div className="form-actions">
            <button type="submit" className="btn btn-primary login-submit" disabled={busy || !codigo.trim()}>
              {busy ? "Activando…" : "Activar instalación"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
