import { signPayload, verifySignature } from "./crypto";

// Corta duración — alcanza para que el updater de Tauri arranque la
// descarga del artefacto justo después de leer el manifiesto, sin
// depender de que sus headers custom (Authorization/X-Installation-Id)
// propaguen hasta la descarga del binario en sí (comportamiento no
// garantizado del plugin updater). El token va firmado y con expiración
// propia en la URL, independiente de esos headers.
const DOWNLOAD_TOKEN_TTL_MS = 10 * 60_000;

export async function issueDownloadToken(assetId: number, secret: string): Promise<string> {
  const expires = Date.now() + DOWNLOAD_TOKEN_TTL_MS;
  const signature = await signPayload(`${assetId}.${expires}`, secret);
  return `${expires}.${signature}`;
}

export async function verifyDownloadToken(assetId: number, token: string, secret: string): Promise<boolean> {
  const [expiresStr, signature] = token.split(".");
  if (!expiresStr || !signature) return false;
  const expires = Number(expiresStr);
  if (!Number.isFinite(expires) || Date.now() > expires) return false;
  return verifySignature(`${assetId}.${expires}`, signature, secret);
}
