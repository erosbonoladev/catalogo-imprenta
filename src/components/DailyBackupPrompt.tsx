import { useEffect, useState } from "react";
import { hasPermission, useAuth } from "../auth";
import { readLocalBackupFile, runBackupNow, saveBackupFileAs } from "../db";

const DAILY_BACKUP_KEY_PREFIX = "catalogo-imprenta:daily-backup-done:";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Reemplaza al backup local diario automático (silencioso, activado por un
 * admin por usuario): ahora quien ya tiene backups_crear ve este aviso al
 * entrar por primera vez en el día y decide si crearlo — nunca corre solo.
 * Si lo pospone ("Ahora no"), no se guarda nada en localStorage, así que
 * vuelve a aparecer en la siguiente apertura de la app ese mismo día.
 */
export default function DailyBackupPrompt() {
  const { user, token } = useAuth();
  const canCrear = hasPermission(user, "backups_crear");
  const [visible, setVisible] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    if (!user || !canCrear) {
      setVisible(false);
      return;
    }
    const storageKey = `${DAILY_BACKUP_KEY_PREFIX}${user.id}`;
    setVisible(localStorage.getItem(storageKey) !== today());
  }, [user?.id, canCrear]);

  async function handleCreate() {
    if (!user || !token || creating) return;
    setCreating(true);
    setError(null);
    try {
      const result = await runBackupNow("BACKUP_LOCAL_DIARIO", "Notificación diaria", user.username);
      if (!result.ok) {
        setError(result.errors.join("; "));
        return;
      }
      localStorage.setItem(`${DAILY_BACKUP_KEY_PREFIX}${user.id}`, today());
      setVisible(false);
      try {
        const bytes = await readLocalBackupFile(result.record.ubicacion);
        await saveBackupFileAs(result.record.archivo, bytes);
      } catch {
        // La copia elegida por el usuario es best-effort; el backup interno
        // ya quedó guardado y registrado en backup_history de todas formas.
      }
    } catch (err) {
      setError(`No se pudo crear el backup: ${String(err)}`);
    } finally {
      setCreating(false);
    }
  }

  if (!visible) return null;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        <h2>Backup diario</h2>
        <p className="hint">
          Todavía no se ha hecho un backup local en esta computadora hoy. Se guarda automáticamente en
          Clio y, si quieres, después puedes elegir guardar además una copia en USB, carpeta compartida,
          etc.
        </p>
        {error && <p className="form-error">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={handleCreate} disabled={creating}>
            {creating ? "Creando…" : "Crear backup"}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setVisible(false)} disabled={creating}>
            Ahora no
          </button>
        </div>
      </div>
    </div>
  );
}
