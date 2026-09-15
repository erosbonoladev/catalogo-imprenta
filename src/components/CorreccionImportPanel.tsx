import { useState } from "react";
import {
  findProductByCodigo,
  getProductDescriptions,
  getProductSpecs,
  logEventAsActor,
  pickExcelFile,
  runBackupNow,
  savePreciosVenta,
  updateProduct,
  type BackupProgress,
} from "../db";
import {
  classifyCorreccionRows,
  readWorkbook,
  type ClassifiedCorreccionRow,
  type RawCorreccionRow,
} from "../correccionImport";
import { isAdmin, useAuth } from "../auth";
import { formatMoney } from "../excelExport";
import type { PrecioVentaCategoria, Product } from "../types";
import BackupProgressBar from "./BackupProgressBar";

type Phase = "picking" | "validating" | "reviewing" | "backing-up" | "committing" | "done";

interface Progress {
  done: number;
  total: number;
}

interface ImportSummary {
  actualizadas: number;
  noEncontradas: number;
  conErrores: number;
  conCambioNombre: number;
  total: number;
  errorRows: { fila: number; motivo: string }[];
}

const CHUNK_SIZE = 25;

const STATUS_LABEL: Record<ClassifiedCorreccionRow["status"], string> = {
  valida: "Se actualizará",
  no_encontrado: "SKU no encontrado",
  error: "Error",
};

const STATUS_BADGE_CLASS: Record<ClassifiedCorreccionRow["status"], string> = {
  valida: "import-status-nueva",
  no_encontrado: "import-status-no-encontrado",
  error: "import-status-error",
};

async function buildLookups(
  rows: RawCorreccionRow[],
  onProgress: (done: number) => void,
): Promise<Map<number, Product | null>> {
  const lookups = new Map<number, Product | null>();
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    await Promise.all(
      chunk.map(async (row) => {
        const product = row.sku ? await findProductByCodigo(row.sku) : null;
        lookups.set(row.fila, product);
      }),
    );
    onProgress(Math.min(i + CHUNK_SIZE, rows.length));
  }
  return lookups;
}

function formatPreciosVenta(precios: Partial<Record<PrecioVentaCategoria, number>> | undefined): string {
  if (!precios) return "—";
  const entries = Object.entries(precios) as [PrecioVentaCategoria, number][];
  if (entries.length === 0) return "—";
  return entries.map(([categoria, precio]) => `${categoria}: ${formatMoney(precio)}`).join(", ");
}

export default function CorreccionImportPanel() {
  const { user, token } = useAuth();
  const [phase, setPhase] = useState<Phase>("picking");
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ClassifiedCorreccionRow[]>([]);
  const [validateProgress, setValidateProgress] = useState<Progress>({ done: 0, total: 0 });
  const [commitProgress, setCommitProgress] = useState<Progress>({ done: 0, total: 0 });
  const [backupProgress, setBackupProgress] = useState<BackupProgress | null>(null);
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
    const classified = classifyCorreccionRows(result.rows, lookups);
    setRows(classified);
    setPhase("reviewing");
  }

  async function handleConfirm() {
    if (!user || !token) return;
    const actor = { id: user.id, token };
    setError(null);
    setPhase("backing-up");
    const backup = await runBackupNow(
      "BACKUP_PRE_IMPORTACION",
      "Captura masiva de corrección de fichas y Precios Venta",
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

    let actualizadas = 0;
    let noEncontradas = 0;
    let conErrores = 0;
    let conCambioNombre = 0;
    const errorRows: { fila: number; motivo: string }[] = [];

    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      await Promise.all(
        chunk.map(async (row) => {
          if (row.status === "error") {
            conErrores += 1;
            errorRows.push({ fila: row.fila, motivo: row.reason ?? "Error desconocido." });
            return;
          }
          if (row.status === "no_encontrado") {
            noEncontradas += 1;
            return;
          }

          const matched = row.matchedProduct;
          if (!matched) {
            conErrores += 1;
            errorRows.push({ fila: row.fila, motivo: "No se encontró la ficha original para actualizar." });
            return;
          }

          try {
            const [specs, descriptions] = await Promise.all([
              getProductSpecs(matched.id),
              getProductDescriptions(matched.id),
            ]);
            await updateProduct(
              actor,
              matched.id,
              {
                codigo: matched.codigo,
                nombre: row.producto.trim(),
                categoria: row.categoria.trim(),
                material: matched.material,
                descripcion: matched.descripcion,
                imagen: matched.imagen,
                imagen_codigo_barras: matched.imagen_codigo_barras,
                tipo_producto: row.tipoProductoNuevo ?? matched.tipo_producto,
                codigo_barras_texto: row.codigoBarrasNuevo ?? matched.codigo_barras_texto,
              },
              specs,
              descriptions,
            );

            const entradas = Object.entries(row.preciosVenta ?? {}) as [PrecioVentaCategoria, number][];
            if (entradas.length > 0) {
              await savePreciosVenta(
                actor,
                matched.id,
                entradas.map(([categoria, precio]) => ({ categoria, precio })),
              );
            }

            actualizadas += 1;
            if (row.nombreCambia) conCambioNombre += 1;
          } catch (err) {
            conErrores += 1;
            errorRows.push({ fila: row.fila, motivo: String(err) });
            logEventAsActor(
              actor,
              "ERROR",
              `Captura masiva de corrección: no se pudo actualizar la fila ${row.fila}: ${String(err)}`,
            );
          }
        }),
      );
      setCommitProgress({ done: Math.min(i + CHUNK_SIZE, rows.length), total: rows.length });
    }

    errorRows.sort((a, b) => a.fila - b.fila);
    setSummary({
      actualizadas,
      noEncontradas,
      conErrores,
      conCambioNombre,
      total: rows.length,
      errorRows,
    });
    logEventAsActor(
      actor,
      "INFO",
      `Captura masiva de corrección de fichas y Precios Venta: ${actualizadas} actualizadas (${conCambioNombre} con cambio de nombre), ${noEncontradas} SKU no encontrados, ${conErrores} con errores (total ${rows.length}).`,
    );
    setPhase("done");
  }

  const validasCount = rows.filter((r) => r.status === "valida").length;
  const noEncontradasCount = rows.filter((r) => r.status === "no_encontrado").length;
  const erroresCount = rows.filter((r) => r.status === "error").length;
  const cambioNombreCount = rows.filter((r) => r.status === "valida" && r.nombreCambia).length;

  return (
    <div>
      <h2>Captura masiva de corrección de fichas y Precios Venta</h2>
      <p className="hint" style={{ marginTop: "0.4rem" }}>
        Carga un archivo Excel (.xlsx) con las columnas SKU, Producto, Categoría, Tipo de
        producto, Código de barras, Gobierno, Representante, Mayoreo, Medio mayoreo y Público
        sugerido. Solo corrige fichas que ya existen (por SKU) — no crea fichas nuevas. Nombre,
        Categoría y Tipo de producto se sobrescriben con lo que traiga el Excel; Código de
        barras y cada precio de venta solo se tocan si la celda trae un valor. No afecta specs,
        imágenes, material ni descripción de Catálogo.
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
            <span className="tag">{validasCount} se actualizarán</span>
            <span className="tag">{cambioNombreCount} con cambio de nombre</span>
            <span className="tag">{noEncontradasCount} SKU no encontrado</span>
            <span className="tag">{erroresCount} con error</span>
            <span className="tag">{rows.length} fila(s) en total</span>
          </div>

          <p className="hint" style={{ margin: 0 }}>
            Revisa especialmente las filas marcadas "El nombre cambiará" antes de confirmar — esta
            importación no pide confirmación por fila, aplica todas las filas válidas de una vez.
          </p>

          <div className="import-review-table-wrap">
            <table className="import-review-table">
              <thead>
                <tr>
                  <th>Fila</th>
                  <th>SKU</th>
                  <th>Producto</th>
                  <th>Categoría</th>
                  <th>Tipo de producto</th>
                  <th>Código de barras</th>
                  <th>Precios Venta</th>
                  <th>Estado</th>
                  <th>Motivo</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.fila}>
                    <td>{row.fila}</td>
                    <td>{row.sku || "—"}</td>
                    <td>{row.producto || "—"}</td>
                    <td>{row.categoria || "—"}</td>
                    <td>{row.tipoProductoNuevo ?? "—"}</td>
                    <td>{row.codigoBarrasNuevo ?? "—"}</td>
                    <td>{formatPreciosVenta(row.preciosVenta)}</td>
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
              <span>{summary.actualizadas}</span>
              <span>Actualizadas</span>
            </div>
            <div className="import-summary-item">
              <span>{summary.conCambioNombre}</span>
              <span>Con cambio de nombre</span>
            </div>
            <div className="import-summary-item">
              <span>{summary.noEncontradas}</span>
              <span>SKU no encontrado</span>
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
