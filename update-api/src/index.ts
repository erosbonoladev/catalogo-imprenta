import type { Env } from "./env";
import { licensingClient, mainReadOnlyClient } from "./dbClients";
import { activateCredential, createCredential, regenerateCredential, CredentialError } from "./logic/credentials";
import {
  listInstallations,
  revokeInstallation,
  reactivateInstallation,
  checkInstallationStatus,
  InstallationError,
} from "./logic/installations";
import { assertActorAuthorized, AdminAuthError } from "./logic/adminAuth";
import { buildUpdateManifest } from "./logic/updateManifest";
import { streamAsset } from "./logic/github";
import { verifyDownloadToken } from "./logic/downloadToken";

// Contrato de auth de esta API (ver docs/DISTRIBUTION.md):
// - /installations/activate: sin auth previa, el código ES la credencial.
// - /installations/status y /updates/*: `Authorization: Bearer <deviceToken>`
//   + `X-Installation-Id: <id>` (excepto /updates/download, que va con su
//   propio token firmado de corta duración en la query string).
// - /admin/*: `Authorization: Bearer <actorToken>` + `X-Actor-Id: <id>` —
//   mismo par {id, token} que el Actor de src/db.ts, verificado acá contra
//   la base principal en modo solo-lectura (assertActorAuthorized).

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function errorResponse(err: unknown): Response {
  if (err instanceof CredentialError || err instanceof InstallationError) {
    return json({ error: err.message }, 400);
  }
  if (err instanceof AdminAuthError) {
    return json({ error: err.message }, 403);
  }
  console.error(err);
  return json({ error: "Error interno del Update API." }, 500);
}

function bearerToken(request: Request): string | null {
  const match = (request.headers.get("authorization") ?? "").match(/^Bearer (.+)$/);
  return match ? match[1] : null;
}

function installationAuth(request: Request): { installationId: number; deviceToken: string } | null {
  const deviceToken = bearerToken(request);
  const installationId = Number(request.headers.get("x-installation-id"));
  if (!deviceToken || !Number.isFinite(installationId) || installationId <= 0) return null;
  return { installationId, deviceToken };
}

function actorAuth(request: Request): { id: number; token: string } | null {
  const token = bearerToken(request);
  const id = Number(request.headers.get("x-actor-id"));
  if (!token || !Number.isFinite(id) || id <= 0) return null;
  return { id, token };
}

async function requireActor(request: Request, mainDb: ReturnType<typeof mainReadOnlyClient>, permiso: string | string[]): Promise<string> {
  const actor = actorAuth(request);
  if (!actor) throw new AdminAuthError("No autorizado: falta identificación de la cuenta administradora.");
  return assertActorAuthorized(mainDb, actor, permiso);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      // --- Activación (sin sesión previa) ---
      if (request.method === "POST" && url.pathname === "/installations/activate") {
        const { code } = await request.json<{ code: string }>();
        const result = await activateCredential(licensingClient(env), code);
        return json(result);
      }

      // --- Heartbeat / estado de la instalación ---
      if (request.method === "POST" && url.pathname === "/installations/status") {
        const auth = installationAuth(request);
        if (!auth) return json({ error: "Falta autenticación de instalación." }, 401);
        const body = await request.json<{ appVersion?: string }>().catch(() => ({}) as { appVersion?: string });
        const result = await checkInstallationStatus(licensingClient(env), auth.installationId, auth.deviceToken, body.appVersion);
        return json(result);
      }

      // --- Manifiesto de actualización (lo consume @tauri-apps/plugin-updater) ---
      if (request.method === "GET" && url.pathname === "/updates/latest") {
        const auth = installationAuth(request);
        if (!auth) return json({ error: "Falta autenticación de instalación." }, 401);
        const status = await checkInstallationStatus(
          licensingClient(env),
          auth.installationId,
          auth.deviceToken,
          url.searchParams.get("currentVersion") ?? undefined,
        );
        if (!status.authorized) {
          const message = status.estado === "no_encontrada" ? "Instalación no reconocida." : "Esta instalación fue revocada.";
          return json({ error: message }, 403);
        }
        const manifest = await buildUpdateManifest(env, `${url.protocol}//${url.host}`);
        // 204 = "no hay actualización nueva", lo que espera el plugin updater
        // de Tauri cuando el endpoint no tiene nada que ofrecer.
        if (!manifest) return new Response(null, { status: 204 });
        return json(manifest);
      }

      // --- Descarga del artefacto (token firmado propio, no Bearer) ---
      if (request.method === "GET" && url.pathname.startsWith("/updates/download/")) {
        const assetId = Number(url.pathname.slice("/updates/download/".length));
        const token = url.searchParams.get("token") ?? "";
        if (!Number.isFinite(assetId) || !(await verifyDownloadToken(assetId, token, env.DOWNLOAD_TOKEN_SECRET))) {
          return json({ error: "Token de descarga inválido o vencido." }, 403);
        }
        return streamAsset(env, assetId);
      }

      // --- Administración (Configuraciones → Instalaciones en CLIO) ---
      const mainDb = mainReadOnlyClient(env);

      if (request.method === "GET" && url.pathname === "/admin/installations") {
        await requireActor(request, mainDb, "instalaciones_ver");
        const installations = await listInstallations(licensingClient(env));
        return json({ installations });
      }

      if (request.method === "POST" && url.pathname === "/admin/credentials") {
        const username = await requireActor(request, mainDb, "instalaciones_crear_credenciales");
        const body = await request.json<{ sede_codigo: string; sede_nombre: string; descripcion: string; usuario_responsable: string }>();
        const result = await createCredential(licensingClient(env), body, username);
        return json(result);
      }

      const revokeMatch = url.pathname.match(/^\/admin\/installations\/(\d+)\/revoke$/);
      if (request.method === "POST" && revokeMatch) {
        const username = await requireActor(request, mainDb, "instalaciones_revocar");
        await revokeInstallation(licensingClient(env), Number(revokeMatch[1]), username);
        return json({ ok: true });
      }

      const reactivateMatch = url.pathname.match(/^\/admin\/installations\/(\d+)\/reactivate$/);
      if (request.method === "POST" && reactivateMatch) {
        const username = await requireActor(request, mainDb, "instalaciones_reactivar");
        await reactivateInstallation(licensingClient(env), Number(reactivateMatch[1]), username);
        return json({ ok: true });
      }

      const regenerateMatch = url.pathname.match(/^\/admin\/credentials\/(\d+)\/regenerate$/);
      if (request.method === "POST" && regenerateMatch) {
        const username = await requireActor(request, mainDb, "instalaciones_crear_credenciales");
        const result = await regenerateCredential(licensingClient(env), Number(regenerateMatch[1]), username);
        return json(result);
      }

      return json({ error: "No encontrado." }, 404);
    } catch (err) {
      return errorResponse(err);
    }
  },
};
