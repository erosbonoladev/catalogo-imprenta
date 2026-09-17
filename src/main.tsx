import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AuthProvider } from "./auth";
import { ThemeProvider } from "./theme";
import { UpdateProvider } from "./updateContext";
import { ActivationProvider, useActivation } from "./activationContext";
import ActivationScreen from "./components/ActivationScreen";

// Gate de instalación (máquina), previo incluso al login de usuario — ver
// docs/DISTRIBUTION.md. Mientras no hay una instalación autorizada (o
// dentro de la ventana de gracia offline), ni UpdateProvider ni
// AuthProvider/App se montan: no tiene sentido chequear actualizaciones ni
// permitir login en una instalación que no está activada o fue revocada.
function ActivationGate() {
  const { status } = useActivation();

  if (status === "checking") {
    return (
      <div className="login-card">
        <p className="hint">Verificando instalación…</p>
      </div>
    );
  }

  if (status === "not-activated" || status === "revoked" || status === "error") {
    return <ActivationScreen />;
  }

  // "authorized" o "grace-period" (sin red, dentro de los 7 días de gracia)
  return (
    <UpdateProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </UpdateProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <ActivationProvider>
        <ActivationGate />
      </ActivationProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
