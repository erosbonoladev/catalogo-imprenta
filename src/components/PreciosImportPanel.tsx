import { useState } from "react";
import { findProductByCodigo, logEvent, pickExcelFile, runBackupNow, upsertPrecio } from "../db";
import {
  classifyPrecioRows,
  computeSkuPrincipal,
  readPreciosWorkbook,
  type ClassifiedPrecioRow,
  type RawPrecioRow,
} from "../precios";
import { isAdmin, useAuth } from "../auth";
import { formatMoney } from "../excelExport";
import basuraIcon from "../../Assets/basura.svg";

type Phase = "picking" | "validating" | "reviewing" | "backing-up" | "committing" | "done";

interface Progress {
  done: number;
  total: number;
}

interface ImportSummary {
  procesados: number;
  actualizados: number;
  noEncontrados: number;
  conErrores: number;
  errorRows: { fila: number; motivo: string }[];
}

const CHUNK_SIZE = 25;

const STATUS_LABEL: Record<ClassifiedPrecioRow["status"], string> = {
  valido: "Encontrado",
  no_encontrado: "No encontrado",
  error: "Error",
};

const STATUS_BADGE_CLASS: Record<ClassifiedPrecioRow["status"], string> = {
  valido: "import-status-nueva",
  no_encontrado: "import-status-no-encontrado",
  error: "import-status-error",
};

async function buildProductExistsMap(
  rows: RawPrecioRow[],
  onProgress: (done: number) => void,
): Promise<Map<string, boolean>> {
  const skusPrincipales = [...new Set(rows.filter((r) => r.sku).map((r) => computeSkuPrincipal(r.sku)))];
  const exists = new Map<string, boolean>();
  for (let i = 0; i < skusPrincipales.length; i += CHUNK_SIZE) {
    const chunk = skusPrincipales.slice(i, i + CHUNK_SIZE);
    await Promise.all(
      chunk.map(async (sku) => {
        const producto = await findProductByCodigo(sku);
        exists.set(sku.toLowerCase(), !!producto);
      }),
    );
    onProgress(Math.min(i + CHUNK_SIZE, skusPrincipales.length));
  }
  return exists;
}

export default function PreciosImportPanel() {
  const { user } = useAuth();
  const [phase, setPhase] = useState<Phase>("picking");
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ClassifiedPrecioRow[]>([]);
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

    const result = readPreciosWorkbook(bytes);
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
    const productExists = await buildProductExistsMap(result.rows, (done) =>
      setValidateProgress({ done, total: result.rows.length }),
    );
    const classified = classifyPrecioRows(result.rows, productExists);
    setRows(classified);
    setPhase("reviewing");
  }

  async function handleConfirm() {
    setError(null);
    setPhase("backing-up");
    const backup = await runBackupNow(
      "BACKUP_PRE_IMPORTACION",
      "Captura masiva de precios",
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

    let actualizados = 0;
    let noEncontrados = 0;
    let conErrores = 0;
    const errorRows: { fila: number; motivo: string }[] = [];

    // Igual que buildProductExistsMap arriba: escribir en chunks concurrentes
    // en vez de un upsertPrecio awaited por fila — con cientos de filas la
    // versión secuencial paga un viaje de red completo por fila.
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      await Promise.all(
        chunk.map(async (row) => {
          if (row.status === "error") {
            conErrores += 1;
            errorRows.push({ fila: row.fila, motivo: row.reason ?? "Error desconocido." });
            return;
          }

          try {
            await upsertPrecio({
              sku: row.sku,
              nombre: row.nombre,
              precio: row.precio ?? 0,
              usuario: user?.username ?? null,
              actualizadoEn: row.fechaIso,
            });
            actualizados += 1;
            if (row.status === "no_encontrado") noEncontrados += 1;
          } catch (err) {
            conErrores += 1;
            errorRows.push({ fila: row.fila, motivo: String(err) });
            logEvent(
              "ERROR",
              `Captura masiva de precios: no se pudo guardar la fila ${row.fila}: ${String(err)}`,
              user?.username ?? null,
            );
          }
        }),
      );
      setCommitProgress({ done: Math.min(i + CHUNK_SIZE, rows.length), total: rows.length });
    }

    errorRows.sort((a, b) => a.fila - b.fila);
    setSummary({
      procesados: rows.length,
      actualizados,
      noEncontrados,
      conErrores,
      errorRows,
    });
    logEvent(
      "INFO",
      `Captura masiva de precios: ${actualizados} actualizados, ${noEncontrados} no encontrados, ${conErrores} con errores (total ${rows.length}).`,
      user?.username ?? null,
    );
    setPhase("done");
  }

  const validosCount = rows.filter((r) => r.status === "valido").length;
  const noEncontradosCount = rows.filter((r) => r.status === "no_encontrado").length;
  const erroresCount = rows.filter((r) => r.status === "error").length;

  return (
    <div>
      <h2>Captura masiva de precios</h2>
      <p className="hint" style={{ marginTop: "0.4rem" }}>
        Carga un archivo Excel (.xlsx) con las columnas SKU, Nombre, Precio y Fecha de
        actualización. Los SKU con letras adicionales (ej. 8059C) se relacionan automáticamente
        con su SKU principal (8059).
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
            <span className="tag">{validosCount} encontrado(s)</span>
            <span className="tag">{noEncontradosCount} no encontrado(s)</span>
            <span className="tag">{erroresCount} con error</span>
            <span className="tag">{rows.length} fila(s) en total</span>
          </div>

          <p className="hint" style={{ margin: 0 }}>
            Las filas "No encontrado" se guardan igual (el SKU principal no tiene una ficha
            técnica todavía) — revísalas para confirmar que no sea un error de captura.
          </p>

          <div className="import-review-table-wrap">
            <table className="import-review-table">
              <thead>
                <tr>
                  <th>Fila</th>
                  <th>SKU</th>
                  <th>Nombre</th>
                  <th>Precio</th>
                  <th>Estado</th>
                  <th>Motivo</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.fila}>
                    <td>{row.fila}</td>
                    <td>{row.sku || "—"}</td>
                    <td>{row.nombre || "—"}</td>
                    <td>{row.precio !== undefined ? formatMoney(row.precio) : "—"}</td>
                    <td>
                      <span className={`import-status-badge ${STATUS_BADGE_CLASS[row.status]}`}>
                        {STATUS_LABEL[row.status]}
                      </span>
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
            <button
              type="button"
              className="icon-btn icon-btn-remove"
              onClick={reset}
              title="Cancelar importación"
              aria-label="Cancelar importación"
            >
              <img src={basuraIcon} alt="" aria-hidden="true" />
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
              <span>{summary.procesados}</span>
              <span>Procesados</span>
            </div>
            <div className="import-summary-item">
              <span>{summary.actualizados}</span>
              <span>Precios actualizados</span>
            </div>
            <div className="import-summary-item">
              <span>{summary.noEncontrados}</span>
              <span>Productos no encontrados</span>
            </div>
            <div className="import-summary-item">
              <span>{summary.conErrores}</span>
              <span>Con errores</span>
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
