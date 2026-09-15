import { useEffect, useState } from "react";
import { hasPermission, isAdmin, useAuth } from "../auth";
import { logEventAsActor } from "../db";
import { PERMISOS_BACKUPS } from "../types";
import UsersPanel from "./UsersPanel";
import ConnectedUsersPanel from "./ConnectedUsersPanel";
import LogsPanel from "./LogsPanel";
import CapturaMasivaPanel from "./CapturaMasivaPanel";
import BackupsPanel from "./BackupsPanel";

type Tab = "usuarios" | "conectados" | "registro" | "backups" | "captura-masiva";

const BASE_TABS: { value: Tab; label: string }[] = [
  { value: "conectados", label: "Usuarios conectados" },
  { value: "registro", label: "Registro" },
];

const ADMIN_TABS: { value: Tab; label: string }[] = [
  { value: "usuarios", label: "Usuarios" },
  { value: "captura-masiva", label: "Captura masiva" },
];

interface Props {
  onDirtyChange?: (dirty: boolean) => void;
}

export default function Configuraciones({ onDirtyChange }: Props) {
  const { user, token } = useAuth();
  const allowedGeneral = hasPermission(user, "configuraciones");
  const allowedBackups = PERMISOS_BACKUPS.some((p) => hasPermission(user, p));
  const allowed = allowedGeneral || allowedBackups;
  const [importBusy, setImportBusy] = useState(false);

  function handleImportBusyChange(busy: boolean) {
    setImportBusy(busy);
    onDirtyChange?.(busy);
  }

  // Administrar usuarios/permisos y Captura masiva quedan detrás de isAdmin,
  // no solo del permiso general "configuraciones" — ver UsersPanel.tsx: ese
  // permiso también da acceso a Logs/Conectados, y otorgarlo no debería
  // implicar poder crear cuentas admin o editar permisos de otros.
  const tabs: { value: Tab; label: string }[] = [
    ...(allowedGeneral ? BASE_TABS : []),
    ...(allowedBackups ? [{ value: "backups" as Tab, label: "Backups" }] : []),
    ...(allowedGeneral && isAdmin(user) ? ADMIN_TABS : []),
  ];

  const [tab, setTab] = useState<Tab>(allowedGeneral && isAdmin(user) ? "usuarios" : allowedGeneral ? "conectados" : "backups");

  useEffect(() => {
    if (allowed || !user || !token) return;
    logEventAsActor({ id: user.id, token }, "WARNING", `Acceso denegado a Configuraciones para ${user.username}`);
  }, [allowed, user, token]);

  if (!allowed) {
    return (
      <div className="private-section">
        <h1>Acceso denegado</h1>
        <p className="hint">No tienes permiso para ver esta sección.</p>
      </div>
    );
  }

  return (
    <div className="private-section">
      <h1>Configuraciones</h1>

      <div className="search-filters" role="group" aria-label="Sección de configuraciones">
        {tabs.map((t) => (
          <button
            key={t.value}
            type="button"
            className={`filter-chip${tab === t.value ? " filter-chip-active" : ""}`}
            disabled={importBusy && tab !== t.value}
            onClick={() => setTab(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {importBusy && (
        <p className="hint" style={{ marginTop: "0.4rem" }}>
          Hay una importación en curso — no se puede cambiar de pestaña hasta que termine.
        </p>
      )}

      {tab === "usuarios" && <UsersPanel />}
      {tab === "conectados" && <ConnectedUsersPanel />}
      {tab === "registro" && <LogsPanel />}
      {tab === "backups" && <BackupsPanel />}
      {tab === "captura-masiva" && <CapturaMasivaPanel onDirtyChange={handleImportBusyChange} />}
    </div>
  );
}
