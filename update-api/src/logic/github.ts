import type { Env } from "../env";

export interface GithubAsset {
  id: number;
  name: string;
}

export interface GithubRelease {
  tag_name: string;
  assets: GithubAsset[];
}

const GITHUB_API = "https://api.github.com";

// Este Worker sirve las actualizaciones de dos apps (Clio y Administrativo),
// cada una con su repo de GitHub; el PAT es el mismo y cubre ambos.
export type UpdateApp = "clio" | "administrativo";

function repoFor(env: Env, app: UpdateApp): string {
  return app === "administrativo" ? env.GITHUB_REPO_ADMINISTRATIVO : env.GITHUB_REPO;
}

function githubHeaders(env: Env): HeadersInit {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "User-Agent": "clio-update-api",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// null = el repo todavía no tiene ningún release publicado (GitHub responde 404).
export async function getLatestRelease(env: Env, app: UpdateApp = "clio"): Promise<GithubRelease | null> {
  const response = await fetch(
    `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${repoFor(env, app)}/releases/latest`,
    { headers: githubHeaders(env) },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GitHub no disponible (${response.status}).`);
  }
  return response.json();
}

// Los releases assets privados no se pueden leer con una URL directa — hay
// que pedirlos a la API con el PAT y `Accept: application/octet-stream`
// (GitHub redirige internamente a la descarga real). Nunca se expone esta
// URL ni el PAT al cliente: todo pasa siempre por este Worker.
export async function fetchAssetContent(env: Env, assetId: number, app: UpdateApp = "clio"): Promise<string> {
  const response = await fetch(
    `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${repoFor(env, app)}/releases/assets/${assetId}`,
    { headers: { ...githubHeaders(env), Accept: "application/octet-stream" } },
  );
  if (!response.ok) {
    throw new Error(`No se pudo leer el archivo de release (${response.status}).`);
  }
  return response.text();
}

export async function streamAsset(env: Env, assetId: number, app: UpdateApp = "clio"): Promise<Response> {
  const response = await fetch(
    `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${repoFor(env, app)}/releases/assets/${assetId}`,
    { headers: { ...githubHeaders(env), Accept: "application/octet-stream" } },
  );
  if (!response.ok) {
    throw new Error(`No se pudo descargar el archivo (${response.status}).`);
  }
  return new Response(response.body, {
    status: 200,
    headers: { "content-type": response.headers.get("content-type") ?? "application/octet-stream" },
  });
}
