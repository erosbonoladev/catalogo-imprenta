import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  clearSession,
  heartbeat,
  logEvent,
  readLocalBackupFile,
  runBackupNow,
  saveBackupFileAs,
  validateSession,
  verifyLogin,
} from "./db";
import type { Permiso, User } from "./types";

const STORAGE_KEY = "catalogo-imprenta:session";
const LAST_LOCAL_BACKUP_KEY_PREFIX = "catalogo-imprenta:last-local-backup:";
const HEARTBEAT_INTERVAL_MS = 20_000;
// Revalida la sesión contra la BD (no solo el heartbeat de presencia) cada
// pocos minutos mientras la app sigue abierta — así una cuenta desactivada,
// una sesión invalidada por un admin, o un vencimiento por inactividad se
// reflejan sin esperar a que el usuario cierre y vuelva a abrir la app.
const SESSION_REVALIDATE_INTERVAL_MS = 5 * 60_000;

export type CurrentUser = User;

export function hasPermission(user: CurrentUser | null, permiso: Permiso): boolean {
  if (!user || !user.activo) return false;
  if (user.rol === "admin") return true;
  return user.permisos.includes(permiso);
}

export function isAdmin(user: CurrentUser | null): boolean {
  return !!user && user.activo && user.rol === "admin";
}

interface AuthContextValue {
  user: CurrentUser | null;
  token: string | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        setLoading(false);
        return;
      }
      try {
        const stored = JSON.parse(raw) as { id: number; token?: string };
        const fresh = stored.token ? await validateSession(stored.id, stored.token) : null;
        if (fresh && stored.token) {
          setUser(fresh);
          setToken(stored.token);
        } else {
          localStorage.removeItem(STORAGE_KEY);
        }
      } catch (err) {
        await logEvent("ERROR", `No se pudo restaurar la sesión: ${String(err)}`);
        localStorage.removeItem(STORAGE_KEY);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!user) return;
    heartbeat(user.id).catch(() => {});
    const interval = setInterval(() => heartbeat(user.id).catch(() => {}), HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [user?.id]);

  // Backup local diario opcional (activado por un admin en UsersPanel): al
  // entrar a la app (login o sesión restaurada), como máximo uno por día en
  // esta máquina — la fecha se guarda en localStorage, no en backup_history
  // (que es compartida en Turso), porque el mismo usuario puede entrar desde
  // más de una computadora el mismo día y cada una necesita su propia copia.
  // El backup ya queda guardado y registrado internamente vía runBackupNow;
  // el diálogo "Guardar como" que sigue es para que la persona elija además
  // dónde quiere su copia en esta máquina (USB, carpeta compartida, etc.) —
  // mismo patrón que "Crear backup ahora" + permiso backups_descargar en
  // BackupsPanel. Cancelar ese diálogo no afecta al backup ya creado.
  useEffect(() => {
    if (!user || !user.backup_local_diario) return;
    const storageKey = `${LAST_LOCAL_BACKUP_KEY_PREFIX}${user.id}`;
    const today = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem(storageKey) === today) return;
    runBackupNow("BACKUP_LOCAL_DIARIO", "Entrada a la app", user.username)
      .then(async (result) => {
        if (!result.ok) return;
        localStorage.setItem(storageKey, today);
        try {
          const bytes = await readLocalBackupFile(result.record.ubicacion);
          await saveBackupFileAs(result.record.archivo, bytes);
        } catch {
          // La copia elegida por el usuario es best-effort; el backup interno
          // ya quedó guardado y registrado en backup_history de todas formas.
        }
      })
      .catch(() => {});
  }, [user?.id]);

  useEffect(() => {
    if (!user || !token) return;
    const interval = setInterval(async () => {
      const fresh = await validateSession(user.id, token).catch(() => undefined);
      // undefined = fallo de red al revalidar, no cerrar sesión por eso; null
      // = la BD dice explícitamente que ya no es válida (vencida, invalidada
      // por un admin, o la cuenta se desactivó) — ahí sí forzar logout.
      if (fresh === null) {
        localStorage.removeItem(STORAGE_KEY);
        setUser(null);
        setToken(null);
      }
    }, SESSION_REVALIDATE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [user, token]);

  const login = useCallback(async (username: string, password: string) => {
    const trimmed = username.trim();
    try {
      const result = await verifyLogin(trimmed, password);
      if (result.status === "locked") {
        await logEvent(
          "WARNING",
          `Intento de inicio de sesión en cuenta bloqueada: ${trimmed}`,
          trimmed,
        );
        return {
          ok: false,
          error: "Demasiados intentos fallidos. La cuenta está bloqueada temporalmente, intenta de nuevo en unos minutos.",
        };
      }
      if (result.status === "invalid") {
        await logEvent("WARNING", `Intento de inicio de sesión fallido: ${trimmed}`, trimmed);
        return { ok: false, error: "Usuario o contraseña incorrectos." };
      }
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ id: result.user.id, token: result.token }),
      );
      setUser(result.user);
      setToken(result.token);
      await logEvent("INFO", `Inicio de sesión: ${result.user.username}`, result.user.username);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `No se pudo iniciar sesión: ${String(err)}` };
    }
  }, []);

  const logout = useCallback(() => {
    if (user) {
      clearSession(user.id).catch(() => {});
      logEvent("INFO", `Cierre de sesión: ${user.username}`, user.username);
    }
    localStorage.removeItem(STORAGE_KEY);
    setUser(null);
    setToken(null);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    getCurrentWindow()
      .onCloseRequested(() => {
        // No se bloquea el cierre de la ventana: limpiar la sesión aquí es
        // "mejor esfuerzo" (localStorage se borra de inmediato; la fila en
        // user_sessions puede o no alcanzar a borrarse antes de que el
        // proceso termine, pero igual desaparece sola por el heartbeat).
        logout();
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [user, logout]);

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
