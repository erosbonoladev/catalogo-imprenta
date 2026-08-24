import { useEffect, useState } from "react";
import { getConnectedUsers } from "../db";
import type { ConnectedUser } from "../types";

const POLL_INTERVAL_MS = 12_000;

export default function ConnectedUsersPanel() {
  const [connected, setConnected] = useState<ConnectedUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      const list = await getConnectedUsers();
      if (!cancelled) {
        setConnected(list);
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

  if (loading) return <p className="hint">Cargando…</p>;

  return (
    <div className="connected-users-panel">
      <p className="hint">
        Usuarios conectados: {connected.length}
        <br />
        Se actualiza automáticamente cada {POLL_INTERVAL_MS / 1000} segundos.
      </p>
      {connected.length === 0 ? (
        <p className="hint">No hay usuarios conectados en este momento.</p>
      ) : (
        <ul className="connected-users-list">
          {connected.map((c) => (
            <li key={c.id}>● {c.username}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
