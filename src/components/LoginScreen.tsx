import { useState, type FormEvent } from "react";
import { useAuth } from "../auth";
import clioLogo from "../../Assets/clio.png";

export default function LoginScreen() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const result = await login(username, password);
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? "No se pudo iniciar sesión.");
    }
  }

  return (
    <div className="login-card">
      <div className="login-header">
        <div className="icon-badge login-header-icon">
          <img src={clioLogo} alt="Clio" />
        </div>
      </div>

      <form onSubmit={handleSubmit} className={busy ? "login-form-busy" : undefined}>
        <input
          type="text"
          className="login-input"
          placeholder="Usuario"
          aria-label="Usuario"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          disabled={busy}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />

        <div className="login-password-wrap">
          <input
            type={showPassword ? "text" : "password"}
            className="login-input login-password-input"
            placeholder="Contraseña"
            aria-label="Contraseña"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="login-password-toggle"
            onClick={() => setShowPassword((v) => !v)}
            disabled={busy}
            aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
            title={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
          >
            {showPassword ? (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
                <line x1="3" y1="21" x2="21" y2="3" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </button>
        </div>

        {error && (
          <p className="form-error login-error" role="alert">
            {error}
          </p>
        )}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary login-submit" disabled={busy}>
            {busy ? "Ingresando…" : "Iniciar sesión"}
          </button>
        </div>
      </form>
    </div>
  );
}
