import { gunzipToText, isGzip, sha256Hex, validateBackupSql, type BackupValidation } from "./backup";

// Mismo motivo que backupWorker.ts: un archivo de restauración subido puede
// pesar hasta MAX_RESTORE_FILE_BYTES (200MB comprimido, varios cientos de MB
// ya descomprimido) — descomprimirlo, parsearlo statement por statement
// (validateBackupSql) y hashearlo es trabajo síncrono pesado que en el hilo
// de UI cuelga la app entera mientras el usuario espera ver la vista previa.
interface RestoreValidationRequest {
  bytes: ArrayBuffer;
}

type RestoreValidationResponse =
  | { ok: true; sql: string; validation: BackupValidation; checksum: string | null }
  | { ok: false; error: string };

// Mismo cast angosto que backupWorker.ts para evitar el choque entre las
// libs "dom" y "webworker" de TypeScript sin tocar tsconfig.
const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<RestoreValidationRequest>) => void) | null;
  postMessage: (data: RestoreValidationResponse) => void;
};

ctx.onmessage = async (e) => {
  try {
    const bytes = new Uint8Array(e.data.bytes);
    const sql = isGzip(bytes) ? await gunzipToText(bytes) : new TextDecoder().decode(bytes);
    const validation = validateBackupSql(sql);
    const checksum = validation.ok ? await sha256Hex(sql) : null;
    ctx.postMessage({ ok: true, sql, validation, checksum });
  } catch (err) {
    ctx.postMessage({ ok: false, error: String(err) });
  }
};
