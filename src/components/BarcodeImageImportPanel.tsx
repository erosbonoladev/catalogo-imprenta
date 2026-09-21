import { useState } from "react";
import {
  allowFsPath,
  findProductsByBarcode,
  listImageFolderFiles,
  listSubfolders,
  logEventAsActor,
  pickImageFolder,
  readBarcodeImageFileBlob,
  runBackupNow,
  updateProductBarcodeImage,
  upsertPendingProductBarcodeImage,
  type BackupProgress,
  type BarcodeMatch,
  type ImageFolderEntry,
} from "../db";
import { classifyBarcodeFolders, type ClassifiedBarcodeRow } from "../barcodeImageImport";
import { isAdmin, useAuth } from "../auth";
import BackupProgressBar from "./BackupProgressBar";

type Phase = "picking" | "validating" | "reviewing" | "backing-up" | "committing" | "done";

interface Progress {
  done: number;
  total: number;
}

interface BarcodeImportSummary {
  asignadas: number;
  sustituidas: number;
  conservadas: number;
  pendientes: number;
  conErrores: number;
  total: number;
  errorRows: { carpeta: string; motivo: string }[];
}

const CHUNK_SIZE = 25;

const STATUS_LABEL: Record<ClassifiedBarcodeRow["status"], string> = {
  nueva: "Nueva imagen",
  sustituir: "Sustituir",
  "no-encontrado": "Se guardará para más adelante",
  error: "Error",
};

async function prepareFolders(
  folders: ImageFolderEntry[],
  onProgress: (done: number) => void,
): Promise<{ filesByFolder: Map<string, ImageFolderEntry[]>; lookups: Map<string, BarcodeMatch[]> }> {
  const filesByFolder = new Map<string, ImageFolderEntry[]>();
  const lookups = new Map<string, BarcodeMatch[]>();
  for (let i = 0; i < folders.length; i += CHUNK_SIZE) {
    const chunk = folders.slice(i, i + CHUNK_SIZE);
    await Promise.all(
      chunk.map(async (folder) => {
        await allowFsPath(folder.path, true);
        const [files, products] = await Promise.all([
          listImageFolderFiles(folder.path),
          findProductsByBarcode(folder.name),
        ]);
        filesByFolder.set(folder.path, files);
        lookups.set(folder.name, products);
      }),
    );
    onProgress(Math.min(i + CHUNK_SIZE, folders.length));
  }
  return { filesByFolder, lookups };
}

export default function BarcodeImageImportPanel() {
  const { user, token } = useAuth();
  const [phase, setPhase] = useState<Phase>("picking");
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ClassifiedBarcodeRow[]>([]);
  const [overwriteChoices, setOverwriteChoices] = useState<Map<number, boolean>>(new Map());
  const [validateProgress, setValidateProgress] = useState<Progress>({ done: 0, total: 0 });
  const [commitProgress, setCommitProgress] = useState<Progress>({ done: 0, total: 0 });
  const [backupProgress, setBackupProgress] = useState<BackupProgress | null>(null);
  const [summary, setSummary] = useState<BarcodeImportSummary | null>(null);

  if (!isAdmin(user)) {
    return (
      <div>
        <h2>Acceso denegado</h2>
        <p className="hint">No tienes permiso para ver esta sección.</p>
      </div>
    );
  }

  function reset() {
    setPhase("picking");
    setError(null);
    setRows([]);
    setOverwriteChoices(new Map());
    setSummary(null);
  }

  async function handlePickFolder() {
    setError(null);
    let folder: string | null;
    try {
      folder = await pickImageFolder();
    } catch (err) {
      setError(`No se pudo abrir la carpeta: ${String(err)}`);
      return;
    }
    if (!folder) return;

    let folders: ImageFolderEntry[];
    try {
      folders = await listSubfolders(folder);
    } catch (err) {
      setError(`No se pudo leer la carpeta: ${String(err)}`);
      return;
    }
    if (folders.length === 0) {
      setError("La carpeta no contiene subcarpetas — cada código de barras debe tener su propia carpeta.");
      return;
    }

    setPhase("validating");
    setValidateProgress({ done: 0, total: folders.length });
    const { filesByFolder, lookups } = await prepareFolders(folders, (done) =>
      setValidateProgress({ done, total: folders.length }),
    );
    const classified = classifyBarcodeFolders(folders, filesByFolder, lookups);
    const overwrite = new Map<number, boolean>();
    for (const row of classified) {
      if (row.status === "sustituir") overwrite.set(row.fila, false);
    }
    setOverwriteChoices(overwrite);
    setRows(classified);
    setPhase("reviewing");
  }

  function setOverwrite(fila: number, value: boolean) {
    setOverwriteChoices((prev) => {
      const next = new Map(prev);
      next.set(fila, value);
      return next;
    });
  }

  function markAllSustituir(value: boolean) {
    setOverwriteChoices((prev) => {
      const next = new Map(prev);
      for (const row of rows) {
        if (row.status === "sustituir") next.set(row.fila, value);
      }
      return next;
    });
  }

  async function handleConfirm() {
    if (!user || !token) return;
    const actor = { id: user.id, token };
    setError(null);
    setPhase("backing-up");
    const backup = await runBackupNow(
      "BACKUP_PRE_IMPORTACION",
      "Captura masiva de código de barras",
      user?.username ?? null,
      setBackupProgress,
    );
    setBackupProgress(null);
    if (!backup.ok) {
      setPhase("reviewing");
      setError(
        `No se pudo crear el backup previo — la importación no se realizó. ${backup.errors.join("; ")}`,
      );
      return;
    }

    setPhase("committing");
    setCommitProgress({ done: 0, total: rows.length });

    let asignadas = 0;
    let sustituidas = 0;
    let conservadas = 0;
    let pendientes = 0;
    let conErrores = 0;
    const errorRows: { carpeta: string; motivo: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      setCommitProgress({ done: i, total: rows.length });

      if (row.status === "error") {
        conErrores += 1;
        errorRows.push({ carpeta: row.carpeta, motivo: row.reason ?? "Error desconocido." });
        continue;
      }
      if (row.status === "sustituir" && !(overwriteChoices.get(row.fila) ?? false)) {
        conservadas += 1;
        continue;
      }

      try {
        if (!row.path) throw new Error("No se encontró el archivo de esta carpeta.");
        const imagen = await readBarcodeImageFileBlob(row.path);

        if (row.status === "no-encontrado") {
          await upsertPendingProductBarcodeImage(actor, {
            codigoBarras: row.carpeta,
            imagen,
            archivoOriginal: row.archivo ?? row.carpeta,
            usuario: user?.username ?? null,
          });
          pendientes += 1;
          continue;
        }

        const product = row.matchedProduct;
        if (!product) throw new Error("No se encontró la ficha técnica de esta carpeta.");
        await updateProductBarcodeImage(actor, product.id, imagen);
        if (row.status === "sustituir") sustituidas += 1;
        else asignadas += 1;
      } catch (err) {
        conErrores += 1;
        errorRows.push({ carpeta: row.carpeta, motivo: String(err) });
        logEventAsActor(
          actor,
          "ERROR",
          `Captura masiva de código de barras: no se pudo procesar la carpeta "${row.carpeta}": ${String(err)}`,
        );
      }
    }

    setCommitProgress({ done: rows.length, total: rows.length });
    setSummary({ asignadas, sustituidas, conservadas, pendientes, conErrores, total: rows.length, errorRows });
    logEventAsActor(
      actor,
      "INFO",
      `Captura masiva de código de barras: ${asignadas} asignadas, ${sustituidas} sustituidas, ${conservadas} conservadas, ${pendientes} guardadas para más adelante, ${conErrores} con errores (total ${rows.length}).`,
    );
    setPhase("done");
  }

  const nuevaCount = rows.filter((r) => r.status === "nueva").length;
  const sustituirCount = rows.filter((r) => r.status === "sustituir").length;
  const noEncontradoCount = rows.filter((r) => r.status === "no-encontrado").length;
  const erroresCount = rows.filter((r) => r.status === "error").length;

  return (
    <div>
      <h2>Captura masiva de código de barras</h2>
      <p className="hint" style={{ marginTop: "0.4rem" }}>
        Selecciona una carpeta que contenga una subcarpeta por cada código de barras, nombrada con
        el número del código (ej. "7501234567890"). Dentro de cada subcarpeta se usa el único
        archivo que se llama exactamente igual al número, sin nada más (png/jpg/webp/gif/svg) — los
        demás archivos de esa subcarpeta se ignoran. La imagen se asigna a la ficha técnica cuyo
        código de barras (texto) coincida con el nombre de la subcarpeta. Si ninguna ficha lo tiene
        todavía, la imagen se guarda y se asigna sola en cuanto se cree un producto con ese código
        de barras.
      </p>

      {phase === "picking" && (
        <div className="import-picker">
          <button type="button" className="btn btn-primary" onClick={handlePickFolder}>
            Seleccionar carpeta de códigos de barras
          </button>
          {error && <p className="form-error">{error}</p>}
        </div>
      )}

      {phase === "validating" && (
        <div className="import-progress">
          <p className="hint" style={{ margin: 0 }}>
            Preparando carpeta {validateProgress.done} de {validateProgress.total}…
          </p>
          <div className="progress-bar">
            <div
              className="progress-bar-fill"
              style={{
                width: `${validateProgress.total ? (validateProgress.done / validateProgress.total) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
      )}

      {phase === "reviewing" && (
        <div className="import-review">
          <div className="import-review-summary">
            <span className="tag">{nuevaCount} nueva(s)</span>
            <span className="tag">{sustituirCount} para sustituir</span>
            <span className="tag">{noEncontradoCount} para guardar (sin ficha todavía)</span>
            <span className="tag">{erroresCount} con error</span>
            <span className="tag">{rows.length} carpeta(s) en total</span>
          </div>

          <p className="hint" style={{ margin: 0 }}>
            Sustituir reemplaza únicamente la imagen de código de barras actual de esa ficha; el
            resto de sus datos no se modifica. Las carpetas sin ficha coincidente se guardan para
            aplicarse solas cuando se cree ese producto; las que tienen error se omiten.
          </p>

          {sustituirCount > 0 && (
            <div className="import-review-actions">
              <button type="button" className="btn btn-secondary" onClick={() => markAllSustituir(true)}>
                Marcar todos: Sustituir
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => markAllSustituir(false)}>
                Marcar todos: Conservar actual
              </button>
            </div>
          )}

          <div className="import-review-table-wrap">
            <table className="import-review-table">
              <thead>
                <tr>
                  <th>Carpeta</th>
                  <th>Archivo</th>
                  <th>Ficha encontrada</th>
                  <th>Estado</th>
                  <th>Acción</th>
                  <th>Motivo</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.fila}>
                    <td>{row.carpeta}</td>
                    <td>{row.archivo ?? "—"}</td>
                    <td>
                      {row.matchedProduct
                        ? `Sí — ${row.matchedProduct.nombre} (${row.matchedProduct.codigo})`
                        : "No"}
                    </td>
                    <td>
                      <span className={`import-status-badge import-status-${row.status}`}>
                        {STATUS_LABEL[row.status]}
                      </span>
                    </td>
                    <td>
                      {row.status === "sustituir" ? (
                        <div className="import-overwrite-cell">
                          <div className="import-review-actions">
                            <button
                              type="button"
                              className={`filter-chip${overwriteChoices.get(row.fila) ? " filter-chip-active" : ""}`}
                              onClick={() => setOverwrite(row.fila, true)}
                            >
                              Sustituir
                            </button>
                            <button
                              type="button"
                              className={`filter-chip${!overwriteChoices.get(row.fila) ? " filter-chip-active" : ""}`}
                              onClick={() => setOverwrite(row.fila, false)}
                            >
                              Conservar actual
                            </button>
                          </div>
                          <span className="import-overwrite-status">
                            {overwriteChoices.get(row.fila)
                              ? "Se sustituirá la imagen existente."
                              : "Se conservará la imagen actual."}
                          </span>
                        </div>
                      ) : row.status === "nueva" ? (
                        "Se asignará"
                      ) : row.status === "no-encontrado" ? (
                        "Se guardará para más adelante"
                      ) : (
                        "Se omitirá"
                      )}
                    </td>
                    <td className="import-review-motivo">{row.reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {error && <p className="form-error">{error}</p>}

          <div className="form-actions">
            <button type="button" className="btn btn-primary" onClick={handleConfirm}>
              Confirmar importación
            </button>
            <button type="button" className="btn btn-secondary" onClick={reset}>
              Cancelar importación
            </button>
          </div>
        </div>
      )}

      {phase === "backing-up" && <BackupProgressBar progress={backupProgress} />}

      {phase === "committing" && (
        <div className="import-progress">
          <p className="hint" style={{ margin: 0 }}>
            Procesando carpeta {commitProgress.done} de {commitProgress.total}…
          </p>
          <div className="progress-bar">
            <div
              className="progress-bar-fill"
              style={{
                width: `${commitProgress.total ? (commitProgress.done / commitProgress.total) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
      )}

      {phase === "done" && summary && (
        <div className="import-review">
          <div className="import-summary-grid">
            <div className="import-summary-item">
              <span>{summary.total}</span>
              <span>Carpetas procesadas</span>
            </div>
            <div className="import-summary-item">
              <span>{summary.asignadas}</span>
              <span>Imágenes asignadas</span>
            </div>
            <div className="import-summary-item">
              <span>{summary.sustituidas}</span>
              <span>Imágenes sustituidas</span>
            </div>
            <div className="import-summary-item">
              <span>{summary.conservadas}</span>
              <span>Conservadas</span>
            </div>
            <div className="import-summary-item">
              <span>{summary.pendientes}</span>
              <span>Guardadas para más adelante</span>
            </div>
            <div className="import-summary-item">
              <span>{summary.conErrores}</span>
              <span>Carpetas con error</span>
            </div>
          </div>

          {summary.errorRows.length > 0 && (
            <div className="import-review-table-wrap">
              <table className="import-review-table">
                <thead>
                  <tr>
                    <th>Carpeta</th>
                    <th>Motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.errorRows.map((e, idx) => (
                    <tr key={`${e.carpeta}-${idx}`}>
                      <td>{e.carpeta}</td>
                      <td className="import-review-motivo">{e.motivo}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={reset}>
              Volver
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
