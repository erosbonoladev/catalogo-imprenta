import type { BackupValidation, DumpIndex, DumpTable } from "./backup";

export interface BackupArchiveResult {
  gz: Uint8Array;
  checksum: string;
  validation: BackupValidation;
}

/**
 * Arma, valida, comprime y hashea el dump del backup en un Web Worker en vez
 * del hilo de UI — ver backupWorker.ts sobre por qué (hacerlo en el hilo
 * principal colgaba la app con las imágenes de products/plastic_products).
 */
export function buildBackupArchive(tables: DumpTable[], indexes: DumpIndex[]): Promise<BackupArchiveResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./backupWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      worker.terminate();
      const data = e.data as
        | { ok: true; gz: ArrayBuffer; checksum: string; validation: BackupValidation }
        | { ok: false; error: string };
      if (data.ok) {
        resolve({ gz: new Uint8Array(data.gz), checksum: data.checksum, validation: data.validation });
      } else {
        reject(new Error(data.error));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "Error desconocido en el worker de backup."));
    };
    worker.postMessage({ tables, indexes });
  });
}

export interface RestoreValidationResult {
  sql: string;
  validation: BackupValidation;
  checksum: string | null;
}

/**
 * Descomprime, valida y hashea un archivo de restauración candidato en un
 * Web Worker en vez del hilo de UI — ver restoreValidationWorker.ts sobre
 * por qué (un archivo subido puede pesar cientos de MB ya descomprimido).
 */
export function validateRestoreFile(bytes: Uint8Array): Promise<RestoreValidationResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./restoreValidationWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      worker.terminate();
      const data = e.data as
        | { ok: true; sql: string; validation: BackupValidation; checksum: string | null }
        | { ok: false; error: string };
      if (data.ok) {
        resolve({ sql: data.sql, validation: data.validation, checksum: data.checksum });
      } else {
        reject(new Error(data.error));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "Error desconocido en el worker de restauración."));
    };
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    worker.postMessage({ bytes: buffer }, [buffer]);
  });
}
