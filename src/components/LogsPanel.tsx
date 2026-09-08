import { useEffect, useState } from "react";
import { getRecentLogs } from "../db";
import { useAuth } from "../auth";
import type { AppLog } from "../types";

const POLL_INTERVAL_MS = 12_000;

export default function LogsPanel() {
  const { user, token } = useAuth();
  const [logs, setLogs] = useState<AppLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !token) return;
    const actor = { id: user.id, token };
    let cancelled = false;
    async function poll() {
      const list = await getRecentLogs(actor, 200);
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
  }, [user, token]);

  if (loading) return <p className="hint">Cargando…</p>;

  return (
    <div className="logs-panel">
      <p className="hint">
        Vista de solo lectura — no ejecuta comandos, solo muestra el historial de eventos.
      </p>

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
