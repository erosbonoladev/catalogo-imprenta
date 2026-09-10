import { useEffect, useRef, useState } from "react";
import { useUpdate } from "../updateContext";
import Toast from "./Toast";
import girarIcon from "../../Assets/girar.svg";

export default function UpdateChecker() {
  const { version, status, update, progress, checkNow, install } = useUpdate();
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const notifiedVersionRef = useRef<string | null>(null);

  // Aviso automático al entrar a la pantalla principal: este componente solo
  // se monta con el Sidebar, es decir ya logueado. Si el chequeo silencioso
  // que arrancó en la pantalla de login (ver UpdateProvider) ya encontró una
  // actualización, "status" llega en "available" desde el primer render y el
  // toast sale de inmediato; si todavía estaba en curso, sale apenas termine.
  useEffect(() => {
    if (status === "available" && update && notifiedVersionRef.current !== update.version) {
      notifiedVersionRef.current = update.version;
      setToastMessage(`Actualización disponible: v${update.version}`);
    }
  }, [status, update]);

  async function handleCheck() {
    const result = await checkNow();
    if (result.status === "uptodate") {
      setToastMessage("Ya tienes la última versión");
    } else if (result.status === "error") {
      setToastMessage(`No se pudo buscar actualizaciones: ${result.message}`);
    }
    // El caso "available" ya se avisa solo por el efecto de arriba.
  }

  async function handleInstall() {
    const result = await install();
    if (!result.ok) {
      setToastMessage(`No se pudo instalar la actualización: ${result.message}`);
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
