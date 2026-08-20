import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

type Status = "idle" | "checking" | "uptodate" | "available" | "downloading" | "error";

export default function UpdateChecker() {
  const [version, setVersion] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  async function handleCheck() {
    setStatus("checking");
    setError(null);
    try {
      const found = await check();
      if (found) {
        setUpdate(found);
        setStatus("available");
      } else {
        setStatus("uptodate");
        setTimeout(() => setStatus("idle"), 3000);
      }
    } catch (err) {
      setError(String(err));
      setStatus("error");
    }
  }

  async function handleInstall() {
    if (!update) return;
    setStatus("downloading");
    setError(null);
    let downloaded = 0;
    let total = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setProgress(total ? Math.min(100, Math.round((downloaded / total) * 100)) : 0);
        }
      });
      await relaunch();
    } catch (err) {
      setError(String(err));
      setStatus("error");
    }
  }

  return (
    <div className="update-checker">
      <span className="update-version">v{version}</span>
      {status === "idle" && (
        <button className="btn btn-secondary" onClick={handleCheck}>
          Buscar actualizaciones
        </button>
      )}
      {status === "checking" && <span className="hint update-hint">Buscando…</span>}
      {status === "uptodate" && (
        <span className="hint update-hint">Ya tienes la última versión</span>
      )}
      {status === "available" && update && (
        <button className="btn btn-primary" onClick={handleInstall}>
          Actualizar a v{update.version}
        </button>
      )}
      {status === "downloading" && (
        <span className="hint update-hint">Instalando… {progress}%</span>
      )}
      {status === "error" && (
        <span className="form-error update-hint" title={error ?? undefined}>
          No se pudo buscar actualizaciones
        </span>
      )}
    </div>
  );
}
