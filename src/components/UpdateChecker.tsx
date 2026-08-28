import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import Toast from "./Toast";
import girarIcon from "../../Assets/girar.svg";

type Status = "idle" | "checking" | "uptodate" | "available" | "downloading" | "error";

export default function UpdateChecker() {
  const [version, setVersion] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState(0);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  async function handleCheck() {
    setStatus("checking");
    try {
      const found = await check();
      if (found) {
        setUpdate(found);
        setStatus("available");
        setToastMessage(`Actualización disponible: v${found.version}`);
      } else {
        setStatus("uptodate");
        setToastMessage("Ya tienes la última versión");
        setTimeout(() => setStatus("idle"), 3000);
      }
    } catch (err) {
      setStatus("error");
      setToastMessage(`No se pudo buscar actualizaciones: ${String(err)}`);
      setTimeout(() => setStatus("idle"), 3000);
    }
  }

  async function handleInstall() {
    if (!update) return;
    setStatus("downloading");
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
      setStatus("error");
      setToastMessage(`No se pudo instalar la actualización: ${String(err)}`);
      setTimeout(() => setStatus("idle"), 3000);
    }
  }

  function handleClick() {
    if (status === "checking" || status === "downloading") return;
    if (status === "available") {
      handleInstall();
    } else {
      handleCheck();
    }
  }

  const spinning = status === "checking" || status === "downloading";

  const title =
    status === "available"
      ? `Actualización disponible: instalar v${update?.version}`
      : status === "checking"
        ? "Buscando actualizaciones…"
        : status === "downloading"
          ? `Instalando… ${progress}%`
          : status === "error"
            ? "No se pudo buscar actualizaciones"
            : "Buscar actualizaciones";

  return (
    <div className="update-checker">
      <button
        type="button"
        className={`icon-btn sidebar-icon-btn update-check-btn${spinning ? " spinning" : ""}${
          status === "error" ? " update-check-error" : ""
        }`}
        onClick={handleClick}
        disabled={spinning}
        title={title}
        aria-label={title}
      >
        <img src={girarIcon} alt="" aria-hidden="true" />
        {status === "available" && <span className="update-badge" aria-hidden="true" />}
      </button>
      <span className="update-version">v{version}</span>

      <Toast
        message={toastMessage ?? ""}
        show={!!toastMessage && status !== "checking" && status !== "downloading"}
        onHide={() => setToastMessage(null)}
      />
    </div>
  );
}
