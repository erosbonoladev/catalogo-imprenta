// Único archivo que le habla al Update API (Cloudflare Worker, ver
// update-api/ y docs/DISTRIBUTION.md) — mismo criterio que src/db.ts siendo
// la única puerta a Turso. Usa @tauri-apps/plugin-http en vez de fetch()
// del navegador por la misma razón que downloadImportedImage() en db.ts: el
// CSP connect-src del webview no incluye este origen, y la petición corre
// en el proceso Rust en vez del webview — el dominio de destino queda
// acotado por capabilities/default.json (http:default), no por esto.
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type {
  Instalacion,
  InstalacionCredencial,
  InstalacionCredencialCreada,
  InstalacionCredencialInput,
} from "./types";

export interface Actor {
  id: number;
  token: string;
}

export interface DeviceCredential {
  installationId: number;
  installationCode: string;
  deviceToken: string;
  sedeNombre: string;
}

export interface InstallationStatus {
  authorized: boolean;
  estado: string;
}

function apiUrl(path: string): string {
  const base = import.meta.env.VITE_UPDATE_API_URL as string | undefined;
  if (!base) {
    throw new Error("VITE_UPDATE_API_URL no está configurada — ver .env.example.");
  }
  return `${base.replace(/\/$/, "")}${path}`;
}

async function parseErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

function actorHeaders(actor: Actor): HeadersInit {
  return { Authorization: `Bearer ${actor.token}`, "X-Actor-Id": String(actor.id) };
}

function installationHeaders(installationId: number, deviceToken: string): HeadersInit {
  return { Authorization: `Bearer ${deviceToken}`, "X-Installation-Id": String(installationId) };
}

// --- Activación de esta instalación (sin sesión de usuario CLIO todavía) ---

export async function activateInstallation(codigo: string): Promise<DeviceCredential> {
  const response = await tauriFetch(apiUrl("/installations/activate"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: codigo }),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "No se pudo activar la instalación."));
  }
  const body = (await response.json()) as {
    installationId: number;
    installationCode: string;
    deviceToken: string;
    sedeNombre: string;
  };
  return body;
}

export async function checkInstallationStatus(
  installationId: number,
  deviceToken: string,
  appVersion?: string,
): Promise<InstallationStatus> {
  const response = await tauriFetch(apiUrl("/installations/status"), {
    method: "POST",
    headers: { ...installationHeaders(installationId, deviceToken), "content-type": "application/json" },
    body: JSON.stringify({ appVersion }),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "No se pudo verificar el estado de la instalación."));
  }
  return response.json();
}

// --- Administración (Configuraciones → Instalaciones, requiere Actor admin/permiso) ---

export async function listInstalaciones(actor: Actor): Promise<Instalacion[]> {
  const response = await tauriFetch(apiUrl("/admin/installations"), {
    method: "GET",
    headers: actorHeaders(actor),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "No se pudo cargar la lista de instalaciones."));
  }
  const body = (await response.json()) as { installations: Instalacion[] };
  return body.installations;
}

export async function crearCredencial(
  actor: Actor,
  input: InstalacionCredencialInput,
): Promise<InstalacionCredencialCreada> {
  const response = await tauriFetch(apiUrl("/admin/credentials"), {
    method: "POST",
    headers: { ...actorHeaders(actor), "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "No se pudo crear la credencial."));
  }
  const body = (await response.json()) as { credencial: InstalacionCredencial; codigo: string };
  return { credencial: body.credencial, codigo: body.codigo };
}

export async function regenerarCredencial(actor: Actor, credentialId: number): Promise<InstalacionCredencialCreada> {
  const response = await tauriFetch(apiUrl(`/admin/credentials/${credentialId}/regenerate`), {
    method: "POST",
    headers: actorHeaders(actor),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "No se pudo regenerar la credencial."));
  }
  const body = (await response.json()) as { credencial: InstalacionCredencial; codigo: string };
  return { credencial: body.credencial, codigo: body.codigo };
}

export async function revocarInstalacion(actor: Actor, installationId: number): Promise<void> {
  const response = await tauriFetch(apiUrl(`/admin/installations/${installationId}/revoke`), {
    method: "POST",
    headers: actorHeaders(actor),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "No se pudo revocar la instalación."));
  }
}

export async function reactivarInstalacion(actor: Actor, installationId: number): Promise<void> {
  const response = await tauriFetch(apiUrl(`/admin/installations/${installationId}/reactivate`), {
    method: "POST",
    headers: actorHeaders(actor),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "No se pudo reactivar la instalación."));
  }
}
