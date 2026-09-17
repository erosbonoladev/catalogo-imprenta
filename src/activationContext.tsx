import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { activateInstallation, checkInstallationStatus, type DeviceCredential } from "./activation";

// Gate de MÁQUINA, previo incluso al login de usuario (ver main.tsx) — no
// reemplaza auth.tsx/AuthProvider, que sigue gateando por usuario una vez
// que la instalación ya está autorizada. Ver docs/DISTRIBUTION.md.

export type ActivationStatus =
  | "checking"
  | "not-activated"
  | "authorized"
  | "grace-period"
  | "revoked"
  | "error";

// Ventana de gracia offline: si la última verificación exitosa contra el
// Update API fue hace menos de 7 días, la app sigue funcionando sin
// internet. Pasado ese punto sin poder validar, bloquea con un mensaje
// claro en vez de dejar una instalación potencialmente revocada autorizada
// para siempre sin volver a consultar al servidor. Una revocación
// confirmada por el servidor bloquea de inmediato, sin esperar la ventana.
const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const REVALIDATE_INTERVAL_MS = 30 * 60_000;

interface StoredCredential {
  installation_id: string;
  device_token: string;
  last_authorized_at: string;
}

interface ActivationContextValue {
  status: ActivationStatus;
  installationCode: string | null;
  sedeNombre: string | null;
  errorMessage: string | null;
  activate: (codigo: string) => Promise<{ ok: boolean; error?: string }>;
}

const ActivationContext = createContext<ActivationContextValue | null>(null);

export function ActivationProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ActivationStatus>("checking");
  const [installationCode, setInstallationCode] = useState<string | null>(null);
  const [sedeNombre, setSedeNombre] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const credentialRef = useRef<StoredCredential | null>(null);

  const persist = useCallback(async (credential: DeviceCredential, lastAuthorizedAt: string) => {
    const stored: StoredCredential = {
      installation_id: String(credential.installationId),
      device_token: credential.deviceToken,
      last_authorized_at: lastAuthorizedAt,
    };
    credentialRef.current = stored;
    await invoke("store_device_credential", {
      installationId: stored.installation_id,
      deviceToken: stored.device_token,
      lastAuthorizedAt: stored.last_authorized_at,
    });
    setInstallationCode(credential.installationCode);
    setSedeNombre(credential.sedeNombre);
  }, []);

  const verify = useCallback(async (stored: StoredCredential) => {
    const appVersion = await getVersion().catch(() => undefined);
    try {
      const result = await checkInstallationStatus(
        Number(stored.installation_id),
        stored.device_token,
        appVersion,
      );
      if (result.authorized) {
        const now = new Date().toISOString();
        credentialRef.current = { ...stored, last_authorized_at: now };
        await invoke("store_device_credential", {
          installationId: stored.installation_id,
          deviceToken: stored.device_token,
          lastAuthorizedAt: now,
        }).catch(() => {});
        setStatus("authorized");
        setErrorMessage(null);
        return;
      }
      // El servidor respondió explícitamente que no está autorizada —
      // bloquea de inmediato, sin esperar la ventana de gracia. No se
      // borra la credencial local: una reactivación futura no debe
      // obligar a reinstalar.
      setStatus("revoked");
      setErrorMessage(
        result.estado === "no_encontrada"
          ? "Esta instalación ya no es reconocida por el servidor."
          : "Esta instalación fue revocada. Contacta a un administrador.",
      );
    } catch {
      // Sin red / servidor no disponible — no es lo mismo que "revocada".
      const elapsed = Date.now() - new Date(stored.last_authorized_at).getTime();
      if (elapsed <= GRACE_PERIOD_MS) {
        setStatus("grace-period");
        setErrorMessage(null);
      } else {
        setStatus("error");
        setErrorMessage(
          "No se pudo verificar la licencia de esta instalación y ya pasaron más de 7 días desde la última vez que se confirmó. Conéctate a internet para continuar.",
        );
      }
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const stored = await invoke<StoredCredential | null>("load_device_credential");
        if (!stored) {
          setStatus("not-activated");
          return;
        }
        credentialRef.current = stored;
        await verify(stored);
      } catch (err) {
        setStatus("error");
        setErrorMessage(String(err));
      }
    })();
  }, [verify]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (credentialRef.current) verify(credentialRef.current);
    }, REVALIDATE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [verify]);

  const activate = useCallback(
    async (codigo: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const credential = await activateInstallation(codigo);
        await persist(credential, new Date().toISOString());
        setStatus("authorized");
        setErrorMessage(null);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    [persist],
  );

  return (
    <ActivationContext.Provider value={{ status, installationCode, sedeNombre, errorMessage, activate }}>
      {children}
    </ActivationContext.Provider>
  );
}

export function useActivation(): ActivationContextValue {
  const ctx = useContext(ActivationContext);
  if (!ctx) throw new Error("useActivation must be used within an ActivationProvider");
  return ctx;
}
