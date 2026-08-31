import { useState, type FormEvent } from "react";
import { useAuth } from "../auth";
import clioLogo from "../../Assets/clio.png";

export default function LoginScreen() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
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
        />

        <input
          type="password"
          className="login-input"
          placeholder="Contraseña"
          aria-label="Contraseña"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />

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
