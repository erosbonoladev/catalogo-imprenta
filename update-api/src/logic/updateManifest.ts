import type { Env } from "../env";
import { getLatestRelease, fetchAssetContent } from "./github";
import { issueDownloadToken } from "./downloadToken";

interface TauriLatestJson {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}

// Lee el latest.json que tauri-action ya publica como asset del release
// (firmado con la clave minisign del proyecto, sin tocar) y reescribe cada
// URL de plataforma para que apunte de vuelta a este Worker en vez de a
// GitHub — así el cliente nunca necesita (ni puede) alcanzar la API de
// GitHub directamente. Devuelve null si el release no tiene ese asset
// (release en construcción/sin firmar todavía).
export async function buildUpdateManifest(env: Env, workerBaseUrl: string): Promise<TauriLatestJson | null> {
  const release = await getLatestRelease(env);
  const manifestAsset = release.assets.find((a) => a.name === "latest.json");
  if (!manifestAsset) return null;

  const raw = await fetchAssetContent(env, manifestAsset.id);
  const manifest = JSON.parse(raw) as TauriLatestJson;

  const reshapedPlatforms: TauriLatestJson["platforms"] = {};
  for (const [platform, info] of Object.entries(manifest.platforms)) {
    const assetName = info.url.split("/").pop() ?? "";
    const asset = release.assets.find((a) => a.name === assetName);
    if (!asset) continue; // no debería pasar: latest.json y los binarios vienen del mismo release
    const token = await issueDownloadToken(asset.id, env.DOWNLOAD_TOKEN_SECRET);
    reshapedPlatforms[platform] = {
      signature: info.signature,
      url: `${workerBaseUrl}/updates/download/${asset.id}?token=${token}`,
    };
  }

  return { ...manifest, platforms: reshapedPlatforms };
}
