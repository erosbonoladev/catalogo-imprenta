import { useEffect, useState } from "react";
import { getRecentLogs } from "../db";
import { useAuth } from "../auth";
import type { AppLog } from "../types";

const POLL_INTERVAL_MS = 12_000;

export default function LogsPanel() {
  const { user, token } = useAuth();
  const [logs, setLogs] = useState<AppLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!user || !token) return;
    const actor = { id: user.id, token };
    let cancelled = false;
    async function poll() {
      // Sin try/catch acá, un error (sesión vencida, blip de red) dejaba el
      // spinner de "Cargando…" para siempre — nunca se llegaba a
      // setLoading(false), y como el poll se repite cada 12s, tampoco había
      // ningún mensaje visible mientras tanto.
      try {
        const list = await getRecentLogs(actor, 200);
        if (!cancelled) {
          setLogs(list);
          setLoadError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "No se pudieron cargar los registros.");
        }
      } finally {
        if (!cancelled) setLoading(false);
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
  if (loadError) return <p className="form-error">No se pudieron cargar los registros: {loadError}</p>;

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
