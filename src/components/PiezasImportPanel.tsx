import { useEffect, useState } from "react";
import {
  downloadImportedImageFromCandidates,
  findPlasticProductInJuegoByNombre,
  findPlasticProductInJuegoBySku,
  findProductByCodigo,
  getLastPiezaImportBatch,
  getPlasticItems,
  importPiezaRow,
  logEventAsActor,
  pickExcelFile,
  recordPiezaImportBatch,
  runBackupNow,
  undoLastPiezaImportBatch,
  type PiezaImportBatch,
} from "../db";
import {
  buildImageLinkCandidates,
  buildPiezaInput,
  classifyPiezaRows,
  readPiezasWorkbook,
  type ClassifiedPiezaRow,
  type PiezaRowLookup,
  type RawPiezaImportRow,
} from "../piezasImport";
import { hasPermission, useAuth } from "../auth";
import type { ImageBlob, Product } from "../types";

type Phase = "picking" | "validating" | "reviewing" | "backing-up" | "committing" | "done";

interface Progress {
  done: number;
  total: number;
}

interface ImportSummary {
  nuevas: number;
  actualizadas: number;
  omitidas: number;
  conErrores: number;
  imagenesFallidas: number;
  total: number;
  errorRows: { fila: number; motivo: string }[];
  imageWarnings: { fila: number; motivo: string }[];
}

const CHUNK_SIZE = 25;

const STATUS_LABEL: Record<ClassifiedPiezaRow["status"], string> = {
  nueva: "Nueva",
  actualizar: "Actualizar",
  "sin-relacion": "Sin relación",
  error: "Error",
};

const IMAGE_LABEL: Record<ClassifiedPiezaRow["imageStatus"], string> = {
  "con-link": "Sí (se descargará)",
  "sin-link": "No",
  "link-invalido": "Link inválido",
};

async function buildLookups(
  rows: RawPiezaImportRow[],
  onProgress: (done: number) => void,
): Promise<Map<number, PiezaRowLookup>> {
  const lookups = new Map<number, PiezaRowLookup>();
  // Muchas filas de pieza comparten el mismo juego (todo el bloque debajo de
  // una fila de encabezado) — se cachea la resolución por juegoSku para no
  // repetir la misma consulta decenas de veces dentro del mismo archivo.
  const juegoCache = new Map<string, Promise<Product | null>>();
  function resolveJuego(juegoSku: string): Promise<Product | null> {
    let cached = juegoCache.get(juegoSku);
    if (!cached) {
      cached = findProductByCodigo(juegoSku);
      juegoCache.set(juegoSku, cached);
    }
    return cached;
  }

  const relevant = rows.filter((r) => r.juegoSku.trim());
  for (let i = 0; i < relevant.length; i += CHUNK_SIZE) {
    const chunk = relevant.slice(i, i + CHUNK_SIZE);
    await Promise.all(
      chunk.map(async (row) => {
        const juego = await resolveJuego(row.juegoSku);
        if (!juego) {
          lookups.set(row.fila, { juego: null, pieza: null });
          return;
        }
        // Con SKU propio, el criterio de duplicado es SKU+juego (más
        // preciso); sin SKU, se compara por nombre+juego.
        const pieza = row.sku.trim()
          ? await findPlasticProductInJuegoBySku(row.sku, juego.id)
          : await findPlasticProductInJuegoByNombre(row.descripcion, juego.id);
        lookups.set(row.fila, { juego, pieza });
      }),
    );
    onProgress(Math.min(i + CHUNK_SIZE, relevant.length));
  }
  return lookups;
}

export default function PiezasImportPanel() {
  const { user, token } = useAuth();
  const allowed = hasPermission(user, "plasticos");
  const [phase, setPhase] = useState<Phase>("picking");
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ClassifiedPiezaRow[]>([]);
  const [overwriteChoices, setOverwriteChoices] = useState<Map<number, boolean>>(new Map());
  const [validateProgress, setValidateProgress] = useState<Progress>({ done: 0, total: 0 });
  const [commitProgress, setCommitProgress] = useState<Progress>({ done: 0, total: 0 });
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [lastBatch, setLastBatch] = useState<PiezaImportBatch | null>(null);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [undoDone, setUndoDone] = useState<number | null>(null);

  useEffect(() => {
    if (allowed || !user || !token) return;
    logEventAsActor({ id: user.id, token }, "WARNING", `Acceso denegado a Captura masiva de piezas para ${user.username}`);
  }, [allowed, user, token]);

  function loadLastBatch() {
    getLastPiezaImportBatch()
      .then(setLastBatch)
      .catch(() => setLastBatch(null));
  }

  useEffect(() => {
    if (!allowed) return;
    loadLastBatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed]);

  if (!allowed) {
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
    loadLastBatch();
  }

  async function handleUndoLastBatch() {
    if (!user || !token) return;
    const actor = { id: user.id, token };
    setUndoing(true);
    setUndoError(null);
    try {
      const { eliminadas } = await undoLastPiezaImportBatch(actor);
      logEventAsActor(
        actor,
        "INFO",
        `Captura masiva de piezas: se deshizo la última importación (${eliminadas} pieza(s) eliminada(s)).`,
      );
      setUndoDone(eliminadas);
      setConfirmUndo(false);
      loadLastBatch();
    } catch (err) {
      setUndoError(`No se pudo deshacer la importación: ${String(err)}`);
    } finally {
      setUndoing(false);
    }
  }

  async function handlePickFile() {
    setError(null);
    let bytes: Uint8Array | null;
    try {
      bytes = await pickExcelFile();
    } catch (err) {
      setError(`No se pudo leer el archivo: ${String(err)}`);
      return;
    }
    if (!bytes) return;

    const result = readPiezasWorkbook(bytes);
    if (!result.ok) {
      setError(
        `El archivo no tiene el formato esperado. Faltan estas columnas: ${result.missingHeaders.join(", ")}.`,
      );
      return;
    }
    if (result.rows.length === 0) {
      setError("El archivo no contiene filas de datos.");
      return;
    }

    setPhase("validating");
    setValidateProgress({ done: 0, total: result.rows.length });
    const lookups = await buildLookups(result.rows, (done) =>
      setValidateProgress({ done, total: result.rows.length }),
    );
    const classified = classifyPiezaRows(result.rows, lookups);
    const overwrite = new Map<number, boolean>();
    for (const row of classified) {
      if (row.status === "actualizar" || row.status === "sin-relacion") overwrite.set(row.fila, false);
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

  function markAllOfStatus(status: ClassifiedPiezaRow["status"], value: boolean) {
    setOverwriteChoices((prev) => {
      const next = new Map(prev);
      for (const row of rows) {
        if (row.status === status) next.set(row.fila, value);
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
      "Captura masiva de piezas",
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

    let nuevas = 0;
    let actualizadas = 0;
    let omitidas = 0;
    let conErrores = 0;
    let imagenesFallidas = 0;
    const errorRows: { fila: number; motivo: string }[] = [];
    const imageWarnings: { fila: number; motivo: string }[] = [];
    const createdIds: number[] = [];
    const nextOrdenByJuego = new Map<number, number>();

    async function nextOrden(juegoId: number): Promise<number> {
      if (!nextOrdenByJuego.has(juegoId)) {
        const existing = await getPlasticItems(juegoId);
        nextOrdenByJuego.set(juegoId, existing.length + 1);
      }
      const orden = nextOrdenByJuego.get(juegoId) as number;
      nextOrdenByJuego.set(juegoId, orden + 1);
      return orden;
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      setCommitProgress({ done: i, total: rows.length });

      if (row.status === "error") {
        conErrores += 1;
        errorRows.push({ fila: row.fila, motivo: row.reason ?? "Error desconocido." });
        continue;
      }
      if ((row.status === "actualizar" || row.status === "sin-relacion") && !(overwriteChoices.get(row.fila) ?? false)) {
        omitidas += 1;
        continue;
      }

      try {
        const juegoId = row.matchedJuego?.id ?? null;

        // La imagen se descarga aparte de los demás datos: si el link falla
        // (link muerto, sin permisos, red), la pieza igual se crea/actualiza
        // sin imagen — un solo link roto no debe bloquear el resto de la fila.
        let downloadedImage: ImageBlob | null = null;
        if (row.imageStatus === "con-link") {
          const candidates = buildImageLinkCandidates(row.linkImagen);
          if (candidates.length > 0) {
            try {
              downloadedImage = await downloadImportedImageFromCandidates(candidates);
            } catch (err) {
              imagenesFallidas += 1;
              imageWarnings.push({ fila: row.fila, motivo: String(err) });
            }
          }
        }

        const input = buildPiezaInput(row, downloadedImage);
        const existing = row.matchedPieza;
        if (existing) {
          await importPiezaRow(actor, juegoId, existing.id, input, 0);
          actualizadas += 1;
        } else {
          const orden = juegoId !== null ? await nextOrden(juegoId) : 0;
          const newId = await importPiezaRow(actor, juegoId, null, input, orden);
          createdIds.push(newId);
          nuevas += 1;
        }
      } catch (err) {
        conErrores += 1;
        errorRows.push({ fila: row.fila, motivo: String(err) });
        logEventAsActor(actor, "ERROR", `Captura masiva de piezas: no se pudo procesar la fila ${row.fila}: ${String(err)}`);
      }
    }

    if (createdIds.length > 0) {
      try {
        await recordPiezaImportBatch(actor, createdIds);
      } catch (err) {
        logEventAsActor(actor, "ERROR", `Captura masiva de piezas: no se pudo registrar el lote para deshacer: ${String(err)}`);
      }
    }

    setCommitProgress({ done: rows.length, total: rows.length });
    setSummary({
      nuevas,
      actualizadas,
      omitidas,
      conErrores,
      imagenesFallidas,
      total: rows.length,
      errorRows,
      imageWarnings,
    });
    logEventAsActor(
      actor,
      "INFO",
      `Captura masiva de piezas: ${nuevas} nuevas, ${actualizadas} actualizadas, ${omitidas} omitidas, ${conErrores} con errores, ${imagenesFallidas} imágenes no descargadas (total ${rows.length}).`,
    );
    setPhase("done");
    loadLastBatch();
  }

  const nuevasCount = rows.filter((r) => r.status === "nueva").length;
  const actualizarCount = rows.filter((r) => r.status === "actualizar").length;
  const sinRelacionCount = rows.filter((r) => r.status === "sin-relacion").length;
  const erroresCount = rows.filter((r) => r.status === "error").length;

  return (
    <div>
      <h2>Captura masiva de piezas</h2>
      <p className="hint" style={{ marginTop: "0.4rem" }}>
        Carga un archivo Excel (.xlsx) con las columnas Origen, SKU, Descripción, Componentes de
        Fabricación, Dimensiones, Peso, Maquila, Costo, Dimensiones Empaque y Links Imágenes
        Piezas. Una fila con SKU sin guion (ej. "1138") es un juego; las filas siguientes son sus
        piezas, tengan o no su propio SKU (ej. "1138-1"), hasta la próxima fila de juego. Si ese
        juego no existe todavía en el catálogo (o una fila de pieza aparece antes de cualquier
        juego), tú decides en la revisión si esa pieza se importa igual sin relacionarla — la
        importación nunca crea juegos nuevos. Las imágenes se descargan automáticamente desde el
        link (Google Drive/Photos).
      </p>

      {lastBatch && phase === "picking" && (
        <div className="import-picker" style={{ marginBottom: "1rem" }}>
          <p className="hint" style={{ margin: 0 }}>
            Última importación de piezas: {lastBatch.total} pieza(s) creada(s) el{" "}
            {lastBatch.creado_en}
            {lastBatch.creado_por ? ` por ${lastBatch.creado_por}` : ""}.
          </p>
          {undoDone !== null && !confirmUndo && (
            <p className="hint" style={{ margin: 0 }}>
              Se eliminaron {undoDone} pieza(s) de la importación anterior.
            </p>
          )}
          {confirmUndo ? (
            <span className="confirm-delete">
              ¿Eliminar las {lastBatch.total} pieza(s) creadas en la última importación masiva?
              Esta acción no se puede deshacer.
              <button
                type="button"
                className="btn btn-danger"
                onClick={handleUndoLastBatch}
                disabled={undoing}
              >
                Sí, eliminar
              </button>
              <button
                type="button"
                className="btn-link"
                onClick={() => setConfirmUndo(false)}
                disabled={undoing}
              >
                Cancelar
              </button>
            </span>
          ) : (
            <button type="button" className="btn btn-secondary" onClick={() => setConfirmUndo(true)}>
              Eliminar última importación masiva
            </button>
          )}
          {undoError && <p className="form-error">{undoError}</p>}
        </div>
      )}

      {phase === "picking" && (
        <div className="import-picker">
          <button type="button" className="btn btn-primary" onClick={handlePickFile}>
            Seleccionar archivo Excel
          </button>
          {error && <p className="form-error">{error}</p>}
        </div>
      )}

      {phase === "validating" && (
        <div className="import-progress">
          <p className="hint" style={{ margin: 0 }}>
            Validando fila {validateProgress.done} de {validateProgress.total}…
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
            <span className="tag">{nuevasCount} nueva(s)</span>
            <span className="tag">{actualizarCount} para actualizar</span>
            <span className="tag">{sinRelacionCount} sin relación con un juego</span>
            <span className="tag">{erroresCount} con error</span>
            <span className="tag">{rows.length} fila(s) en total</span>
          </div>

          <p className="hint" style={{ margin: 0 }}>
            Actualizar reemplaza Origen/Descripción/Dimensiones/Peso/Maquila/Costo/Componentes de
            fabricación/Dimensiones de empaque de esa pieza con lo que traiga el Excel. Color,
            Material y Tipo de empaque no se tocan si el archivo no los trae. La imagen solo se
            reemplaza si el link de esa fila se pudo descargar. Las filas "Sin relación" no
            encontraron un juego — si decides importarlas, quedan en el catálogo de Piezas sin
            asociarse a ningún juego, listas para relacionarlas a mano después.
          </p>

          {actualizarCount > 0 && (
            <div className="import-review-actions">
              <span className="hint" style={{ margin: 0 }}>Para actualizar:</span>
              <button type="button" className="btn btn-secondary" onClick={() => markAllOfStatus("actualizar", true)}>
                Marcar todos: Actualizar
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => markAllOfStatus("actualizar", false)}>
                Marcar todos: Omitir
              </button>
            </div>
          )}

          {sinRelacionCount > 0 && (
            <div className="import-review-actions">
              <span className="hint" style={{ margin: 0 }}>Para sin relación:</span>
              <button type="button" className="btn btn-secondary" onClick={() => markAllOfStatus("sin-relacion", true)}>
                Marcar todos: Importar sin relación
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => markAllOfStatus("sin-relacion", false)}>
                Marcar todos: Omitir
              </button>
            </div>
          )}

          <div className="import-review-table-wrap">
            <table className="import-review-table">
              <thead>
                <tr>
                  <th>Fila</th>
                  <th>SKU</th>
                  <th>Descripción</th>
                  <th>Juego</th>
                  <th>Imagen</th>
                  <th>Estado</th>
                  <th>Acción</th>
                  <th>Motivo</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.fila}>
                    <td>{row.fila}</td>
                    <td>{row.sku || "—"}</td>
                    <td>{row.descripcion || "—"}</td>
                    <td>
                      {row.matchedJuego
                        ? `${row.matchedJuego.codigo} — ${row.matchedJuego.nombre}`
                        : row.juegoSku
                          ? `${row.juegoSku} (no encontrado)`
                          : "—"}
                    </td>
                    <td>{IMAGE_LABEL[row.imageStatus]}</td>
                    <td>
                      <span className={`import-status-badge import-status-${row.status}`}>
                        {STATUS_LABEL[row.status]}
                      </span>
                    </td>
                    <td>
                      {row.status === "actualizar" || row.status === "sin-relacion" ? (
                        <div className="import-overwrite-cell">
                          <div className="import-review-actions">
                            <button
                              type="button"
                              className={`filter-chip${overwriteChoices.get(row.fila) ? " filter-chip-active" : ""}`}
                              onClick={() => setOverwrite(row.fila, true)}
                            >
                              {row.status === "actualizar"
                                ? "Actualizar"
                                : row.matchedPieza
                                  ? "Actualizar sin relación"
                                  : "Importar sin relación"}
                            </button>
                            <button
                              type="button"
                              className={`filter-chip${!overwriteChoices.get(row.fila) ? " filter-chip-active" : ""}`}
                              onClick={() => setOverwrite(row.fila, false)}
                            >
                              Omitir
                            </button>
                          </div>
                          <span className="import-overwrite-status">
                            {overwriteChoices.get(row.fila)
                              ? row.status === "actualizar"
                                ? "Se actualizará la pieza existente."
                                : row.matchedPieza
                                  ? "Se actualizará la pieza huérfana existente, sin relacionarla."
                                  : "Se creará en el catálogo, sin relacionarla a un juego."
                              : "Se omitirá esta fila."}
                          </span>
                        </div>
                      ) : row.status === "nueva" ? (
                        "Se creará"
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
            Procesando fila {commitProgress.done} de {commitProgress.total} (incluye descarga de
            imágenes)…
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
          <p className="hint" style={{ margin: 0 }}>Importación completada.</p>
          <div className="import-summary-grid">
            <div className="import-summary-item">
              <span>{summary.nuevas}</span>
              <span>Registros nuevos</span>
            </div>
            <div className="import-summary-item">
              <span>{summary.actualizadas}</span>
              <span>Registros actualizados</span>
            </div>
            <div className="import-summary-item">
              <span>{summary.omitidas}</span>
              <span>Omitidos</span>
            </div>
            <div className="import-summary-item">
              <span>{summary.conErrores}</span>
              <span>Registros con errores</span>
            </div>
            <div className="import-summary-item">
              <span>{summary.imagenesFallidas}</span>
              <span>Imágenes no descargadas</span>
            </div>
            <div className="import-summary-item">
              <span>{summary.total}</span>
              <span>Total procesado</span>
            </div>
          </div>

          {summary.errorRows.length > 0 && (
            <div className="import-review-table-wrap">
              <table className="import-review-table">
                <thead>
                  <tr>
                    <th>Fila</th>
                    <th>Motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.errorRows.map((e) => (
                    <tr key={e.fila}>
                      <td>{e.fila}</td>
                      <td className="import-review-motivo">{e.motivo}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {summary.imageWarnings.length > 0 && (
            <div className="import-review-table-wrap">
              <p className="hint" style={{ margin: 0 }}>
                Estas piezas se guardaron correctamente, pero su imagen no se pudo descargar:
              </p>
              <table className="import-review-table">
                <thead>
                  <tr>
                    <th>Fila</th>
                    <th>Motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.imageWarnings.map((w) => (
                    <tr key={w.fila}>
                      <td>{w.fila}</td>
                      <td className="import-review-motivo">{w.motivo}</td>
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
