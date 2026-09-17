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

function githubHeaders(env: Env): HeadersInit {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "User-Agent": "clio-update-api",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function getLatestRelease(env: Env): Promise<GithubRelease> {
  const response = await fetch(
    `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/latest`,
    { headers: githubHeaders(env) },
  );
  if (!response.ok) {
    throw new Error(`GitHub no disponible (${response.status}).`);
  }
  return response.json();
}

// Los releases assets privados no se pueden leer con una URL directa — hay
// que pedirlos a la API con el PAT y `Accept: application/octet-stream`
// (GitHub redirige internamente a la descarga real). Nunca se expone esta
// URL ni el PAT al cliente: todo pasa siempre por este Worker.
export async function fetchAssetContent(env: Env, assetId: number): Promise<string> {
  const response = await fetch(
    `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/assets/${assetId}`,
    { headers: { ...githubHeaders(env), Accept: "application/octet-stream" } },
  );
  if (!response.ok) {
    throw new Error(`No se pudo leer el archivo de release (${response.status}).`);
  }
  return response.text();
}

export async function streamAsset(env: Env, assetId: number): Promise<Response> {
  const response = await fetch(
    `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/assets/${assetId}`,
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
