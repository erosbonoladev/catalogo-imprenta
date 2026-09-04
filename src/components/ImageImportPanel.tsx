import { useState } from "react";
import {
  findProductByCodigo,
  listImageFolderFiles,
  logEvent,
  pickImageFolder,
  readImageFileBlob,
  runBackupNow,
  updateProductImage,
  upsertPendingProductImage,
  type ImageFolderEntry,
} from "../db";
import {
  classifyImageEntries,
  fullStemFromFilename,
  skuFromFilename,
  type ClassifiedImageRow,
} from "../imageImport";
import { isAdmin, useAuth } from "../auth";
import type { Product } from "../types";

type Phase = "picking" | "validating" | "reviewing" | "backing-up" | "committing" | "done";

interface Progress {
  done: number;
  total: number;
}

interface ImageImportSummary {
  asignadas: number;
  sustituidas: number;
  conservadas: number;
  pendientes: number;
  conErrores: number;
  total: number;
  errorRows: { archivo: string; motivo: string }[];
}

const CHUNK_SIZE = 25;

const STATUS_LABEL: Record<ClassifiedImageRow["status"], string> = {
  nueva: "Nueva imagen",
  sustituir: "Sustituir",
  "no-encontrado": "Se guardará para más adelante",
  error: "Error",
};

async function buildImageLookups(
  entries: ImageFolderEntry[],
  onProgress: (done: number) => void,
): Promise<Map<string, Product | null>> {
  const lookups = new Map<string, Product | null>();
  // Se consultan ambos candidatos por archivo: el nombre completo (match de
  // siempre, cubre códigos que ya traen guion propio) y el SKU recortado al
  // inicio del nombre (nuevo) — classifyImageEntries decide cuál usar.
  const candidates = new Set<string>();
  for (const e of entries) {
    candidates.add(fullStemFromFilename(e.name));
    const sku = skuFromFilename(e.name);
    if (sku) candidates.add(sku);
  }
  const skus = Array.from(candidates).filter(Boolean);
  for (let i = 0; i < skus.length; i += CHUNK_SIZE) {
    const chunk = skus.slice(i, i + CHUNK_SIZE);
    await Promise.all(
      chunk.map(async (sku) => {
        lookups.set(sku, await findProductByCodigo(sku));
      }),
    );
    onProgress(Math.min(i + CHUNK_SIZE, skus.length));
  }
  return lookups;
}

export default function ImageImportPanel() {
  const { user, token } = useAuth();
  const [phase, setPhase] = useState<Phase>("picking");
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ClassifiedImageRow[]>([]);
  const [overwriteChoices, setOverwriteChoices] = useState<Map<number, boolean>>(new Map());
  const [validateProgress, setValidateProgress] = useState<Progress>({ done: 0, total: 0 });
  const [commitProgress, setCommitProgress] = useState<Progress>({ done: 0, total: 0 });
  const [summary, setSummary] = useState<ImageImportSummary | null>(null);

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

    let entries: ImageFolderEntry[];
    try {
      entries = await listImageFolderFiles(folder);
    } catch (err) {
      setError(`No se pudo leer la carpeta: ${String(err)}`);
      return;
    }
    if (entries.length === 0) {
      setError("La carpeta no contiene archivos.");
      return;
    }

    setPhase("validating");
    setValidateProgress({ done: 0, total: entries.length });
    const lookups = await buildImageLookups(entries, (done) =>
      setValidateProgress({ done, total: entries.length }),
    );
    const classified = classifyImageEntries(entries, lookups);
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
      "Captura masiva de imágenes",
      user?.username ?? null,
    );
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
    const errorRows: { archivo: string; motivo: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      setCommitProgress({ done: i, total: rows.length });

      if (row.status === "error") {
        conErrores += 1;
        errorRows.push({ archivo: row.archivo, motivo: row.reason ?? "Error desconocido." });
        continue;
      }
      if (row.status === "sustituir" && !(overwriteChoices.get(row.fila) ?? false)) {
        conservadas += 1;
        continue;
      }

      if (row.status === "no-encontrado") {
        try {
          const imagen = await readImageFileBlob(row.path);
          await upsertPendingProductImage(actor, {
            codigo: row.sku,
            imagen,
            archivoOriginal: row.archivo,
            usuario: user?.username ?? null,
          });
          pendientes += 1;
        } catch (err) {
          conErrores += 1;
          errorRows.push({ archivo: row.archivo, motivo: String(err) });
          logEvent(
            "ERROR",
            `Captura masiva de imágenes: no se pudo guardar la imagen pendiente de "${row.archivo}": ${String(err)}`,
            user?.username ?? null,
          );
        }
        continue;
      }

      try {
        const product = row.matchedProduct;
        if (!product) throw new Error("No se encontró la ficha técnica para esta imagen.");
        const imagen = await readImageFileBlob(row.path);
        await updateProductImage(product.id, imagen);
        if (row.status === "sustituir") sustituidas += 1;
        else asignadas += 1;
      } catch (err) {
        conErrores += 1;
        errorRows.push({ archivo: row.archivo, motivo: String(err) });
        logEvent(
          "ERROR",
          `Captura masiva de imágenes: no se pudo procesar "${row.archivo}": ${String(err)}`,
          user?.username ?? null,
        );
      }
    }

    setCommitProgress({ done: rows.length, total: rows.length });
    setSummary({ asignadas, sustituidas, conservadas, pendientes, conErrores, total: rows.length, errorRows });
    logEvent(
      "INFO",
      `Captura masiva de imágenes: ${asignadas} asignadas, ${sustituidas} sustituidas, ${conservadas} conservadas, ${pendientes} guardadas para más adelante, ${conErrores} con errores (total ${rows.length}).`,
      user?.username ?? null,
    );
    setPhase("done");
  }

  const nuevaCount = rows.filter((r) => r.status === "nueva").length;
  const sustituirCount = rows.filter((r) => r.status === "sustituir").length;
  const noEncontradoCount = rows.filter((r) => r.status === "no-encontrado").length;
  const erroresCount = rows.filter((r) => r.status === "error").length;

  return (
    <div>
      <h2>Captura masiva de imágenes</h2>
      <p className="hint" style={{ marginTop: "0.4rem" }}>
        Selecciona una carpeta con imágenes (png/jpg/webp/gif) cuyo nombre de archivo empiece con
        el código de la ficha técnica — el resto del nombre (separado por espacio, guion, o pegado
        directo como "7234Circulos...") se ignora. Solo se actualiza la imagen de cada ficha; el
        código, nombre, especificaciones y demás datos no se modifican. Si el código no corresponde
        a ninguna ficha todavía, la imagen se guarda y se asigna sola en cuanto se cree un producto
        con ese código.
      </p>

      {phase === "picking" && (
        <div className="import-picker">
          <button type="button" className="btn btn-primary" onClick={handlePickFolder}>
            Seleccionar carpeta de imágenes
          </button>
          {error && <p className="form-error">{error}</p>}
        </div>
      )}

      {phase === "validating" && (
        <div className="import-progress">
          <p className="hint" style={{ margin: 0 }}>
            Validando archivo {validateProgress.done} de {validateProgress.total}…
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
            <span className="tag">{rows.length} archivo(s) en total</span>
          </div>

          <p className="hint" style={{ margin: 0 }}>
            Sustituir reemplaza únicamente la imagen actual de esa ficha técnica; el resto de sus
            datos no se modifica. Las imágenes sin ficha encontrada se guardan para aplicarse solas
            cuando se cree ese producto; las que tienen error se omiten.
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
                  <th>Archivo</th>
                  <th>Código</th>
                  <th>Ficha encontrada</th>
                  <th>Estado</th>
                  <th>Acción</th>
                  <th>Motivo</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.fila}>
                    <td>{row.archivo}</td>
                    <td>{row.sku || "—"}</td>
                    <td>{row.matchedProduct ? `Sí — ${row.matchedProduct.nombre}` : "No"}</td>
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

      {phase === "backing-up" && (
        <div className="import-progress">
          <p className="hint" style={{ margin: 0 }}>
            Creando backup previo — la importación no comenzará hasta que se verifique…
          </p>
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: "100%" }} />
          </div>
        </div>
      )}

      {phase === "committing" && (
        <div className="import-progress">
          <p className="hint" style={{ margin: 0 }}>
            Procesando imagen {commitProgress.done} de {commitProgress.total}…
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
              <span>Imágenes procesadas</span>
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
              <span>Archivos con error</span>
            </div>
          </div>

          {summary.errorRows.length > 0 && (
            <div className="import-review-table-wrap">
              <table className="import-review-table">
                <thead>
                  <tr>
                    <th>Archivo</th>
                    <th>Motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.errorRows.map((e, idx) => (
                    <tr key={`${e.archivo}-${idx}`}>
                      <td>{e.archivo}</td>
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
