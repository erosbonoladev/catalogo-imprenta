import { useState } from "react";
import {
  createProduct,
  findProductByCodigo,
  findProductsByNombre,
  logEvent,
  pickExcelFile,
  runBackupNow,
  setPresentacionOriginal,
  updateProduct,
} from "../db";
import {
  buildSpecsForRow,
  classifyRows,
  readWorkbook,
  type ClassifiedRow,
  type RawImportRow,
  type RowLookup,
} from "../fichaImport";
import { isAdmin, useAuth } from "../auth";

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
  total: number;
  errorRows: { fila: number; motivo: string }[];
}

const CHUNK_SIZE = 25;

const STATUS_LABEL: Record<ClassifiedRow["status"], string> = {
  nueva: "Nueva",
  duplicada: "Duplicada",
  error: "Error",
};

async function buildLookups(
  rows: RawImportRow[],
  onProgress: (done: number) => void,
): Promise<Map<number, RowLookup>> {
  const lookups = new Map<number, RowLookup>();
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    await Promise.all(
      chunk.map(async (row) => {
        const [byCodigo, byNombre] = await Promise.all([
          row.clave ? findProductByCodigo(row.clave) : Promise.resolve(null),
          findProductsByNombre(row.producto),
        ]);
        lookups.set(row.fila, { byCodigo, byNombre });
      }),
    );
    onProgress(Math.min(i + CHUNK_SIZE, rows.length));
  }
  return lookups;
}

export default function FichaImportPanel() {
  const { user, token } = useAuth();
  const [phase, setPhase] = useState<Phase>("picking");
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ClassifiedRow[]>([]);
  const [overwriteChoices, setOverwriteChoices] = useState<Map<number, boolean>>(new Map());
  const [validateProgress, setValidateProgress] = useState<Progress>({ done: 0, total: 0 });
  const [commitProgress, setCommitProgress] = useState<Progress>({ done: 0, total: 0 });
  const [summary, setSummary] = useState<ImportSummary | null>(null);

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

    const result = readWorkbook(bytes);
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
    const classified = classifyRows(result.rows, lookups);
    const overwrite = new Map<number, boolean>();
    for (const row of classified) {
      if (row.status === "duplicada") overwrite.set(row.fila, false);
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

  function markAllDuplicates(value: boolean) {
    setOverwriteChoices((prev) => {
      const next = new Map(prev);
      for (const row of rows) {
        if (row.status === "duplicada") next.set(row.fila, value);
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
      "Captura masiva de fichas técnicas",
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
    const errorRows: { fila: number; motivo: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      setCommitProgress({ done: i, total: rows.length });

      if (row.status === "error") {
        conErrores += 1;
        errorRows.push({ fila: row.fila, motivo: row.reason ?? "Error desconocido." });
        continue;
      }

      const specs = buildSpecsForRow(row).map((spec, idx) => ({
        ...spec,
        orden: idx + 1,
        permite_requisicion: false,
      }));

      if (row.status === "nueva") {
        try {
          const id = await createProduct(
            actor,
            {
              codigo: row.clave,
              nombre: row.producto,
              categoria: row.categoria,
              material: row.material,
              descripcion: row.descripcion,
              imagen: null,
              imagen_codigo_barras: null,
            },
            specs,
          );
          if (row.presentacion.trim()) {
            await setPresentacionOriginal(id, row.presentacion.trim());
          }
          nuevas += 1;
        } catch (err) {
          conErrores += 1;
          errorRows.push({ fila: row.fila, motivo: String(err) });
          logEvent(
            "ERROR",
            `Captura masiva: no se pudo crear la fila ${row.fila}: ${String(err)}`,
            user?.username ?? null,
          );
        }
        continue;
      }

      // duplicada
      const overwrite = overwriteChoices.get(row.fila) ?? false;
      if (!overwrite) {
        omitidas += 1;
        continue;
      }
      try {
        const existing = row.matchedProduct;
        if (!existing) throw new Error("No se encontró el producto original para sobrescribir.");
        await updateProduct(
          actor,
          existing.id,
          {
            codigo: row.clave || existing.codigo,
            nombre: row.producto,
            categoria: row.categoria,
            material: row.material,
            descripcion: row.descripcion,
            imagen: existing.imagen,
            imagen_codigo_barras: existing.imagen_codigo_barras,
          },
          specs,
        );
        if (row.presentacion.trim()) {
          await setPresentacionOriginal(existing.id, row.presentacion.trim());
        }
        actualizadas += 1;
      } catch (err) {
        conErrores += 1;
        errorRows.push({ fila: row.fila, motivo: String(err) });
        logEvent(
          "ERROR",
          `Captura masiva: no se pudo actualizar la fila ${row.fila}: ${String(err)}`,
          user?.username ?? null,
        );
      }
    }

    setCommitProgress({ done: rows.length, total: rows.length });
    setSummary({ nuevas, actualizadas, omitidas, conErrores, total: rows.length, errorRows });
    logEvent(
      "INFO",
      `Captura masiva de fichas técnicas: ${nuevas} nuevas, ${actualizadas} actualizadas, ${omitidas} omitidas, ${conErrores} con errores (total ${rows.length}).`,
      user?.username ?? null,
    );
    setPhase("done");
  }

  const nuevasCount = rows.filter((r) => r.status === "nueva").length;
  const duplicadasCount = rows.filter((r) => r.status === "duplicada").length;
  const erroresCount = rows.filter((r) => r.status === "error").length;

  return (
    <div>
      <h2>Captura masiva de fichas técnicas</h2>
      <p className="hint" style={{ marginTop: "0.4rem" }}>
        Carga un archivo Excel (.xlsx) con las columnas Clave, Producto, Categoría, Descripción,
        Presentación / Contenido, Medidas y Material. No afecta la información de Piezas ni de
        Imprenta.
      </p>

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
            <span className="tag">{duplicadasCount} duplicada(s)</span>
            <span className="tag">{erroresCount} con error</span>
            <span className="tag">{rows.length} fila(s) en total</span>
          </div>

          <p className="hint" style={{ margin: 0 }}>
            Sobrescribir reemplaza todas las especificaciones existentes de esa ficha (incluidas
            las agregadas manualmente) y sus columnas Categoría/Descripción/Material con lo que
            traiga el Excel. La imagen y el código no se pierden si la fila no trae uno nuevo.
          </p>

          {duplicadasCount > 0 && (
            <div className="import-review-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => markAllDuplicates(true)}
              >
                Marcar todos: Sobrescribir
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => markAllDuplicates(false)}
              >
                Marcar todos: Omitir
              </button>
            </div>
          )}

          <div className="import-review-table-wrap">
            <table className="import-review-table">
              <thead>
                <tr>
                  <th>Fila</th>
                  <th>Clave</th>
                  <th>Producto</th>
                  <th>Estado</th>
                  <th>Acción</th>
                  <th>Motivo</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.fila}>
                    <td>{row.fila}</td>
                    <td>{row.clave || "—"}</td>
                    <td>{row.producto || "—"}</td>
                    <td>
                      <span className={`import-status-badge import-status-${row.status}`}>
                        {STATUS_LABEL[row.status]}
                      </span>
                    </td>
                    <td>
                      {row.status === "duplicada" ? (
                        <div className="import-overwrite-cell">
                          <div className="import-review-actions">
                            <button
                              type="button"
                              className={`filter-chip${overwriteChoices.get(row.fila) ? " filter-chip-active" : ""}`}
                              onClick={() => setOverwrite(row.fila, true)}
                            >
                              Sobrescribir
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
                              ? "Se sobrescribirá la ficha existente."
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
            Procesando fila {commitProgress.done} de {commitProgress.total}…
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
              <span>{summary.nuevas}</span>
              <span>Nuevas</span>
            </div>
            <div className="import-summary-item">
              <span>{summary.actualizadas}</span>
              <span>Actualizadas</span>
            </div>
            <div className="import-summary-item">
              <span>{summary.omitidas}</span>
              <span>Omitidas</span>
            </div>
            <div className="import-summary-item">
              <span>{summary.conErrores}</span>
              <span>Con errores</span>
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
