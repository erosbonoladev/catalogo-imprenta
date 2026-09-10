import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateStatus = "idle" | "checking" | "uptodate" | "available" | "downloading" | "error";

type CheckResult =
  | { status: "available"; update: Update }
  | { status: "uptodate" }
  | { status: "error"; message: string };

type InstallResult = { ok: true } | { ok: false; message: string };

interface UpdateContextValue {
  version: string;
  status: UpdateStatus;
  update: Update | null;
  progress: number;
  checkNow: () => Promise<CheckResult>;
  install: () => Promise<InstallResult>;
}

const UpdateContext = createContext<UpdateContextValue | null>(null);

export function UpdateProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState("");
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState(0);
  const startedRef = useRef(false);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  const checkNow = useCallback(async (): Promise<CheckResult> => {
    setStatus("checking");
    try {
      const found = await check();
      if (found) {
        setUpdate(found);
        setStatus("available");
        return { status: "available", update: found };
      }
      setUpdate(null);
      setStatus("uptodate");
      setTimeout(() => setStatus("idle"), 3000);
      return { status: "uptodate" };
    } catch (err) {
      const message = String(err);
      setStatus("error");
      setTimeout(() => setStatus("idle"), 3000);
      return { status: "error", message };
    }
  }, []);

  // Chequeo automático y silencioso apenas arranca la app — ya corre mientras
  // se muestra la pantalla de login, antes de que el usuario termine de
  // escribir sus credenciales, así el resultado ya está listo (status
  // "available") para avisarle apenas entra a la pantalla principal, sin
  // que tenga que pedirlo a mano desde el botón de la barra lateral. Guardia
  // con ref (no solo el efecto vacío) porque React.StrictMode monta los
  // efectos dos veces en dev y no queremos disparar el chequeo por duplicado.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    checkNow();
  }, [checkNow]);

  const install = useCallback(async (): Promise<InstallResult> => {
    if (!update) return { ok: false, message: "No hay actualización pendiente" };
    setStatus("downloading");
    setProgress(0);
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
      return { ok: true };
    } catch (err) {
      const message = String(err);
      setStatus("error");
      setTimeout(() => setStatus("idle"), 3000);
      return { ok: false, message };
    }
  }, [update]);

  return (
    <UpdateContext.Provider value={{ version, status, update, progress, checkNow, install }}>
      {children}
    </UpdateContext.Provider>
  );
}

export function useUpdate(): UpdateContextValue {
  const ctx = useContext(UpdateContext);
  if (!ctx) throw new Error("useUpdate must be used within an UpdateProvider");
  return ctx;
}
