import {
  buildBackupSql,
  gzipText,
  sha256Hex,
  validateBackupSql,
  type BackupValidation,
  type DumpIndex,
  type DumpTable,
} from "./backup";

// Corre en un Web Worker, no en el hilo de UI: armar el SQL (hex-encode de
// BLOBs de imagen, que en products/plastic_products suman ~150MB) más
// validarlo y comprimirlo es una operación síncrona pesada — hacerla en el
// hilo principal es lo que colgaba la app entera durante un backup local
// (confirmado contra backup_history de producción: backups fallidos con
// "RangeError: Invalid array length" y corridas que quedaron EN_PROCESO,
// señal de que el proceso se cerró a la fuerza mientras corría).
interface BackupWorkerRequest {
  tables: DumpTable[];
  indexes: DumpIndex[];
}

type BackupWorkerResponse =
  | { ok: true; gz: ArrayBuffer; checksum: string; validation: BackupValidation }
  | { ok: false; error: string };

// self.postMessage/onmessage traen el tipado de Window por defecto (lib
// "dom"); agregar lib "webworker" al proyecto entero chocaría con ese mismo
// tipado en el resto de la app — este cast angosto evita el conflicto sin
// tocar tsconfig.
const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<BackupWorkerRequest>) => void) | null;
  postMessage: (data: BackupWorkerResponse, transfer?: Transferable[]) => void;
};

ctx.onmessage = async (e) => {
  try {
    const { tables, indexes } = e.data;
    const { sql } = buildBackupSql(tables, indexes);
    const validation = validateBackupSql(sql);
    const [gz, checksum] = await Promise.all([gzipText(sql), sha256Hex(sql)]);
    ctx.postMessage({ ok: true, gz: gz.buffer, checksum, validation }, [gz.buffer]);
  } catch (err) {
    ctx.postMessage({ ok: false, error: String(err) });
  }
};
