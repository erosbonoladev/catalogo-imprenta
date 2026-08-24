import { useEffect, useState } from "react";
import { hasPermission, useAuth } from "../auth";
import { logEvent } from "../db";
import UsersPanel from "./UsersPanel";
import ConnectedUsersPanel from "./ConnectedUsersPanel";
import LogsPanel from "./LogsPanel";

interface Props {
  onBack: () => void;
}

type Tab = "usuarios" | "conectados" | "registro";

const TABS: { value: Tab; label: string }[] = [
  { value: "usuarios", label: "Usuarios" },
  { value: "conectados", label: "Usuarios conectados" },
  { value: "registro", label: "Registro" },
];

export default function Configuraciones({ onBack }: Props) {
  const { user } = useAuth();
  const allowed = hasPermission(user, "configuraciones");
  const [tab, setTab] = useState<Tab>("usuarios");

  useEffect(() => {
    if (allowed) return;
    logEvent(
      "WARNING",
      `Acceso denegado a Configuraciones para ${user?.username ?? "desconocido"}`,
      user?.username ?? null,
    );
  }, [allowed, user?.username]);

  if (!allowed) {
    return (
      <div className="private-section">
        <button className="btn-link" onClick={onBack}>
          ← Volver al menú principal
        </button>
        <h1>Acceso denegado</h1>
        <p className="hint">No tienes permiso para ver esta sección.</p>
      </div>
    );
  }

  return (
    <div className="private-section">
      <button className="btn-link" onClick={onBack}>
        ← Volver al menú principal
      </button>
      <h1>Configuraciones</h1>

      <div className="search-filters" role="group" aria-label="Sección de configuraciones">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            className={`filter-chip${tab === t.value ? " filter-chip-active" : ""}`}
            onClick={() => setTab(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "usuarios" && <UsersPanel />}
      {tab === "conectados" && <ConnectedUsersPanel />}
      {tab === "registro" && <LogsPanel />}
    </div>
  );
}
