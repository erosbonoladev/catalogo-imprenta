import { useEffect, useState } from "react";
import { clearLogs, getRecentLogs, logEvent } from "../db";
import type { AppLog } from "../types";
import { useAuth } from "../auth";
import basuraIcon from "../../Assets/basura.svg";

const POLL_INTERVAL_MS = 12_000;

export default function LogsPanel() {
  const { user } = useAuth();
  const [logs, setLogs] = useState<AppLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      const list = await getRecentLogs(200);
      if (!cancelled) {
        setLogs(list);
        setLoading(false);
      }
    }
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  async function handleClear() {
    setClearing(true);
    try {
      await clearLogs();
      await logEvent(
        "INFO",
        `Registro de eventos limpiado por ${user?.username ?? "desconocido"}`,
        user?.username ?? null,
      );
      setLogs(await getRecentLogs(200));
    } finally {
      setClearing(false);
      setConfirmingClear(false);
    }
  }

  if (loading) return <p className="hint">Cargando…</p>;

  return (
    <div className="logs-panel">
      <p className="hint">
        Vista de solo lectura — no ejecuta comandos, solo muestra el historial de eventos.
      </p>

      <div className="form-actions" style={{ margin: "0.75rem 0" }}>
        {confirmingClear ? (
          <span className="confirm-delete">
            ¿Limpiar todo el registro?
            <button className="btn btn-danger" onClick={handleClear} disabled={clearing}>
              {clearing ? "Limpiando…" : "Sí, limpiar"}
            </button>
            <button className="btn-link" onClick={() => setConfirmingClear(false)}>
              Cancelar
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="icon-btn icon-btn-remove"
            onClick={() => setConfirmingClear(true)}
            title="Limpiar registro"
            aria-label="Limpiar registro"
          >
            <img src={basuraIcon} alt="" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="log-terminal">
        {logs.length === 0 ? (
          <div className="log-line">Sin eventos registrados todavía.</div>
        ) : (
          logs.map((log) => (
            <div className={`log-line log-${log.nivel.toLowerCase()}`} key={log.id}>
              <span className="log-time">[{formatTime(log.creado_en)}]</span>{" "}
              <span className="log-level">{log.nivel.padEnd(7)}</span>
              {log.usuario && <span className="log-user">({log.usuario}) </span>}
              <span className="log-message">{log.mensaje}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  const withZone = iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`;
  const date = new Date(withZone);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString();
}
