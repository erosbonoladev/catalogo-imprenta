import { useState, type FormEvent } from "react";
import { useAuth } from "../auth";

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
    <div className="password-gate">
      <h1>Catálogo Imprenta</h1>
      <p className="hint">Ingresa tu usuario y contraseña para continuar.</p>

      <form onSubmit={handleSubmit}>
        <label>
          Usuario
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
        </label>

        <label>
          Contraseña
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && <p className="form-error">{error}</p>}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Ingresando…" : "Iniciar sesión"}
          </button>
        </div>
      </form>
    </div>
  );
}
