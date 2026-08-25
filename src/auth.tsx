import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { clearSession, getUserById, heartbeat, logEvent, verifyLogin } from "./db";
import type { Permiso, User } from "./types";

const STORAGE_KEY = "catalogo-imprenta:session";
const HEARTBEAT_INTERVAL_MS = 20_000;

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
  loading: boolean;
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        setLoading(false);
        return;
      }
      try {
        const stored = JSON.parse(raw) as { id: number };
        const fresh = await getUserById(stored.id);
        if (fresh && fresh.activo) {
          setUser(fresh);
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

  const login = useCallback(async (username: string, password: string) => {
    const trimmed = username.trim();
    try {
      const found = await verifyLogin(trimmed, password);
      if (!found) {
        await logEvent("WARNING", `Intento de inicio de sesión fallido: ${trimmed}`, trimmed);
        return { ok: false, error: "Usuario o contraseña incorrectos." };
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: found.id, username: found.username }));
      setUser(found);
      await logEvent("INFO", `Inicio de sesión: ${found.username}`, found.username);
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
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
