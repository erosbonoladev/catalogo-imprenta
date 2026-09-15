import { useEffect, useRef, useState } from "react";
import {
  createProduct,
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
import Toast from "./Toast";

type Phase = "picking" | "validating" | "reviewing" | "backing-up" | "committing" | "done";

interface Progress {
  done: number;
  total: number;
}

interface ImportSummary {
  actualizadas: number;
  creadas: number;
  conErrores: number;
  conCambioNombre: number;
  total: number;
  errorRows: { fila: number; motivo: string }[];
}

const CHUNK_SIZE = 25;

const STATUS_LABEL: Record<ClassifiedCorreccionRow["status"], string> = {
  actualiza: "Se actualizará",
  crea: "Ficha nueva (SKU no existe)",
  error: "Error",
};

const STATUS_BADGE_CLASS: Record<ClassifiedCorreccionRow["status"], string> = {
  actualiza: "import-status-actualizar",
  crea: "import-status-nueva",
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

function formatPreciosVenta(precios: Partial<Record<PrecioVentaCategoria, number | null>> | undefined): string {
  if (!precios) return "—";
  const entries = Object.entries(precios) as [PrecioVentaCategoria, number | null][];
  if (entries.length === 0) return "—";
  return entries
    .map(([categoria, precio]) => `${categoria}: ${precio === null ? "Por definir" : formatMoney(precio)}`)
    .join(", ");
}

interface Props {
  // Solo se dispara durante backing-up/committing (fases que escriben en la
  // BD) — no durante picking/validating/reviewing, que son seguras de
  // abandonar. Ver nota larga junto al useEffect que lo llama: sin esto, el
  // padre (CapturaMasivaPanel/Configuraciones) deja cambiar de pestaña a
  // mitad de una importación y el commit sigue corriendo solo en segundo
  // plano, invisible, con riesgo real de que el usuario reintente y termine
  // escribiendo la misma fila dos veces.
  onDirtyChange?: (dirty: boolean) => void;
}

export default function CorreccionImportPanel({ onDirtyChange }: Props) {
  const { user, token } = useAuth();
  const [phase, setPhase] = useState<Phase>("picking");
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ClassifiedCorreccionRow[]>([]);
  const [nameChangeChoices, setNameChangeChoices] = useState<Map<number, boolean>>(new Map());
  const [onlyNameChanges, setOnlyNameChanges] = useState(false);
  const [validateProgress, setValidateProgress] = useState<Progress>({ done: 0, total: 0 });
  const [commitProgress, setCommitProgress] = useState<Progress>({ done: 0, total: 0 });
  const [backupProgress, setBackupProgress] = useState<BackupProgress | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Si el componente se desmonta (usuario cambia de pestaña) a mitad de
  // handleConfirm, el bucle de commit deja de arrancar filas nuevas en la
  // siguiente vuelta — sin esto seguía escribiendo en la BD en segundo
  // plano de forma invisible, y si el usuario volvía a intentar la misma
  // importación (pensando que no había hecho nada) terminaba escribiendo
  // las mismas filas dos veces.
  const unmountedRef = useRef(false);
  useEffect(() => {
    // React.StrictMode monta los efectos dos veces en dev (mount → cleanup
    // → mount) — sin este reset, la primera "desmontada" simulada dejaba
    // unmountedRef.current en true para siempre y el commit no procesaba
    // ninguna fila (ver mismo patrón/comentario en updateContext.tsx).
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  useEffect(() => {
    onDirtyChange?.(phase === "backing-up" || phase === "committing");
  }, [phase, onDirtyChange]);

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
    setNameChangeChoices(new Map());
    setOnlyNameChanges(false);
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
    const nameChanges = new Map<number, boolean>();
    for (const row of classified) {
      if (row.status === "actualiza" && row.nombreCambia) nameChanges.set(row.fila, false);
    }
    setNameChangeChoices(nameChanges);
    setRows(classified);
    setPhase("reviewing");
  }

  function setNameChange(fila: number, value: boolean) {
    setNameChangeChoices((prev) => {
      const next = new Map(prev);
      next.set(fila, value);
      return next;
    });
  }

  function markAllNameChanges(value: boolean) {
    setNameChangeChoices((prev) => {
      const next = new Map(prev);
      for (const row of rows) {
        if (row.status === "actualiza" && row.nombreCambia) next.set(row.fila, value);
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
    let creadas = 0;
    let conErrores = 0;
    let conCambioNombre = 0;
    const errorRows: { fila: number; motivo: string }[] = [];

    async function applyPreciosVenta(productId: number, row: ClassifiedCorreccionRow) {
      const entradas = Object.entries(row.preciosVenta ?? {}) as [PrecioVentaCategoria, number | null][];
      if (entradas.length === 0) return;
      await savePreciosVenta(
        actor,
        productId,
        entradas.map(([categoria, precio]) => ({ categoria, precio })),
      );
    }

    // Secuencial, no en chunks concurrentes como buildLookups: cada fila abre
    // dos transacciones de escritura propias (updateProduct/createProduct y
    // luego savePreciosVenta) — 25 filas en paralelo (CHUNK_SIZE) significa
    // hasta 50 transacciones de escritura solapadas, lo que revienta con
    // "SQLITE_BUSY: database is locked" y deja la fila sin aplicar sin que
    // se note (queda contada como error, pero con cientos de filas en vuelo
    // a la vez el usuario ve "no se aplicó nada"). Mismo patrón ya usado en
    // FichaImportPanel/PiezasImportPanel para sus fases de commit.
    for (let i = 0; i < rows.length && !unmountedRef.current; i++) {
      const row = rows[i];
      setCommitProgress({ done: i, total: rows.length });

      if (row.status === "error") {
        conErrores += 1;
        errorRows.push({ fila: row.fila, motivo: row.reason ?? "Error desconocido." });
        continue;
      }

      if (row.status === "crea") {
        try {
          const newId = await createProduct(
            actor,
            {
              codigo: row.sku.trim(),
              nombre: row.producto.trim(),
              categoria: row.categoria.trim(),
              material: "",
              descripcion: "",
              imagen: null,
              imagen_codigo_barras: null,
              tipo_producto: row.tipoProductoNuevo ?? "",
              codigo_barras_texto: row.codigoBarrasNuevo ?? "",
            },
            [],
            [],
          );
          await applyPreciosVenta(newId, row);
          creadas += 1;
        } catch (err) {
          conErrores += 1;
          errorRows.push({ fila: row.fila, motivo: String(err) });
          logEventAsActor(
            actor,
            "ERROR",
            `Captura masiva de corrección: no se pudo crear la ficha de la fila ${row.fila}: ${String(err)}`,
          );
        }
        continue;
      }

      const matched = row.matchedProduct;
      if (!matched) {
        conErrores += 1;
        errorRows.push({ fila: row.fila, motivo: "No se encontró la ficha original para actualizar." });
        continue;
      }

      try {
        const [specs, descriptions] = await Promise.all([
          getProductSpecs(matched.id),
          getProductDescriptions(matched.id),
        ]);
        const acceptaCambioNombre = !row.nombreCambia || (nameChangeChoices.get(row.fila) ?? false);
        await updateProduct(
          actor,
          matched.id,
          {
            codigo: matched.codigo,
            nombre: acceptaCambioNombre ? row.producto.trim() : matched.nombre,
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

        await applyPreciosVenta(matched.id, row);

        actualizadas += 1;
        if (row.nombreCambia && acceptaCambioNombre) conCambioNombre += 1;
      } catch (err) {
        conErrores += 1;
        errorRows.push({ fila: row.fila, motivo: String(err) });
        logEventAsActor(
          actor,
          "ERROR",
          `Captura masiva de corrección: no se pudo actualizar la fila ${row.fila}: ${String(err)}`,
        );
      }
    }
    setCommitProgress({ done: rows.length, total: rows.length });

    errorRows.sort((a, b) => a.fila - b.fila);
    logEventAsActor(
      actor,
      "INFO",
      `Captura masiva de corrección de fichas y Precios Venta: ${actualizadas} actualizadas (${conCambioNombre} con cambio de nombre), ${creadas} fichas nuevas creadas, ${conErrores} con errores (total ${rows.length}).`,
    );
    // Si se desmontó a mitad de camino (usuario cambió de pestaña pese al
    // aviso de dirty), no queda nadie mirando el resumen/toast — el log de
    // arriba ya deja constancia de hasta dónde llegó.
    if (unmountedRef.current) return;
    setSummary({
      actualizadas,
      creadas,
      conErrores,
      conCambioNombre,
      total: rows.length,
      errorRows,
    });
    setToastMessage(
      `Importación completada: ${actualizadas} actualizadas, ${creadas} creadas, ${conErrores} con errores.`,
    );
    setPhase("done");
  }

  const actualizaCount = rows.filter((r) => r.status === "actualiza").length;
  const creaCount = rows.filter((r) => r.status === "crea").length;
  const erroresCount = rows.filter((r) => r.status === "error").length;
  const cambioNombreCount = rows.filter((r) => r.status === "actualiza" && r.nombreCambia).length;
  // Filtro de solo vista — no cambia qué filas se procesan al confirmar, solo cuáles se listan.
  const displayedRows = onlyNameChanges
    ? rows.filter((r) => r.status === "actualiza" && r.nombreCambia)
    : rows;

  return (
    <div>
      <h2>Captura masiva de corrección de fichas y Precios Venta</h2>
      <p className="hint" style={{ marginTop: "0.4rem" }}>
        Carga un archivo Excel (.xlsx) con las columnas SKU, Producto, Categoría, Tipo de
        producto, Código de barras, Gobierno, Representante, Mayoreo, Medio mayoreo y Público
        sugerido. Corrige fichas que ya existen (por SKU) y da de alta una ficha nueva cuando el
        SKU no existe todavía (revisa bien las filas "Ficha nueva" antes de confirmar — un SKU mal
        escrito crea una ficha fantasma en vez de quedar como error). Categoría y Tipo de
        producto se sobrescriben con lo que traiga el Excel; Código de barras y cada precio de
        venta solo se tocan si la celda trae un valor ("Por definir" es válido y deja el precio
        explícitamente sin asignar). El cambio de Nombre en una ficha existente hay que aceptarlo
        fila por fila (por defecto se mantiene el nombre actual). No afecta specs, imágenes,
        material ni descripción de Catálogo de fichas existentes; en una ficha nueva esos campos
        quedan vacíos.
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
            <span className="tag">{actualizaCount} se actualizarán</span>
            <span className="tag">{creaCount} fichas nuevas</span>
            <span className="tag">{cambioNombreCount} con cambio de nombre</span>
            <span className="tag">{erroresCount} con error</span>
            <span className="tag">{rows.length} fila(s) en total</span>
          </div>

          <p className="hint" style={{ margin: 0 }}>
            Revisa especialmente las filas de "Ficha nueva" antes de confirmar — el resto de los
            campos válidos se aplica de una vez al confirmar. Las filas marcadas "El nombre
            cambiará" son la excepción: por defecto se mantiene el nombre actual, tenés que
            aceptar el cambio fila por fila (o con "Marcar todos") para que se aplique.
          </p>

          {cambioNombreCount > 0 && (
            <div className="import-review-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => markAllNameChanges(true)}
              >
                Marcar todos: Aceptar cambio de nombre
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => markAllNameChanges(false)}
              >
                Marcar todos: Mantener nombre actual
              </button>
              <button
                type="button"
                className={`filter-chip${onlyNameChanges ? " filter-chip-active" : ""}`}
                onClick={() => setOnlyNameChanges((v) => !v)}
              >
                Mostrar solo cambios de nombre ({cambioNombreCount})
              </button>
            </div>
          )}

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
                  <th>Cambio de nombre</th>
                  <th>Motivo</th>
                </tr>
              </thead>
              <tbody>
                {displayedRows.map((row) => (
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
                    <td>
                      {row.status === "actualiza" && row.nombreCambia ? (
                        <div className="import-overwrite-cell">
                          <div className="import-review-actions">
                            <button
                              type="button"
                              className={`filter-chip${nameChangeChoices.get(row.fila) ? " filter-chip-active" : ""}`}
                              onClick={() => setNameChange(row.fila, true)}
                            >
                              Aceptar cambio
                            </button>
                            <button
                              type="button"
                              className={`filter-chip${!nameChangeChoices.get(row.fila) ? " filter-chip-active" : ""}`}
                              onClick={() => setNameChange(row.fila, false)}
                            >
                              Mantener actual
                            </button>
                          </div>
                          <span className="import-overwrite-status">
                            {nameChangeChoices.get(row.fila)
                              ? "Se aplicará el nombre nuevo."
                              : "Se mantiene el nombre actual."}
                          </span>
                        </div>
                      ) : (
                        "—"
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
            Procesando fila {commitProgress.done} de {commitProgress.total}… Fila por fila para no
            saturar la base de datos — con archivos grandes puede tardar varios minutos. No
            cierres ni cambies de pantalla hasta que termine.
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
              <span>{summary.creadas}</span>
              <span>Fichas nuevas creadas</span>
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

      <Toast
        message={toastMessage ?? ""}
        show={!!toastMessage}
        onHide={() => setToastMessage(null)}
      />
    </div>
  );
}
