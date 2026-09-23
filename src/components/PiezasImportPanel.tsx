import { useEffect, useState } from "react";
import {
  downloadImportedImageFromCandidates,
  findPlasticProductGlobalByNombre,
  findPlasticProductGlobalBySku,
  findPlasticProductInJuegoByNombre,
  findPlasticProductInJuegoByOrden,
  findPlasticProductInJuegoBySku,
  findProductByCodigo,
  getLastPiezaImportBatch,
  getPlasticItems,
  getProductsUsingPlasticProduct,
  importPiezaRow,
  logEventAsActor,
  pickExcelFile,
  recordPiezaImportBatch,
  runBackupNow,
  undoLastPiezaImportBatch,
  type BackupProgress,
  type PiezaImportBatch,
} from "../db";
import {
  buildImageLinkCandidates,
  buildPiezaInput,
  classifyPiezaRows,
  pieceName,
  readPiezasWorkbook,
  type ClassifiedPiezaRow,
  type PiezaGlobalDuplicado,
  type PiezaRowLookup,
  type RawPiezaImportRow,
} from "../piezasImport";
import { hasPermission, useAuth } from "../auth";
import type { ImageBlob, Product } from "../types";
import BackupProgressBar from "./BackupProgressBar";

type Phase = "picking" | "validating" | "reviewing" | "backing-up" | "committing" | "done";

interface Progress {
  done: number;
  total: number;
}

interface ImportSummary {
  nuevas: number;
  actualizadas: number;
  vinculadas: number;
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
        // Cascada de emparejamiento, primer resultado gana: SKU propio
        // (más preciso) -> posición (product_plastic_items.orden, solo la
        // trae el formato "Desglose" — encuentra la pieza aunque una
        // depuración externa le haya cambiado el SKU o el nombre, ver
        // "Cambios aplicados" en WORKFLOWS.md) -> nombre dentro del juego
        // (comportamiento clásico, único disponible para el formato
        // agrupado por bloques).
        let pieza = row.sku.trim() ? await findPlasticProductInJuegoBySku(row.sku, juego.id) : null;
        if (!pieza && row.orden != null) {
          pieza = await findPlasticProductInJuegoByOrden(juego.id, row.orden);
        }
        if (!pieza) {
          pieza = await findPlasticProductInJuegoByNombre(pieceName(row), juego.id);
        }

        // La fila sería "nueva" dentro de su propio juego — antes de darlo
        // por hecho, se busca en TODO el catálogo (otro juego, o sin
        // ninguno) por SKU exacto primero (más preciso) y, si no hay SKU o
        // no matchea, por nombre exacto. Es solo una señal para la
        // revisión: nunca vincula la pieza encontrada por sí sola.
        let globalDuplicado: PiezaGlobalDuplicado | null = null;
        if (!pieza) {
          const bySku = row.sku.trim() ? await findPlasticProductGlobalBySku(row.sku) : null;
          const found = bySku ?? (await findPlasticProductGlobalByNombre(pieceName(row)));
          if (found) {
            const usadaEn = await getProductsUsingPlasticProduct(found.id);
            globalDuplicado = { pieza: found, matchedBy: bySku ? "sku" : "nombre", usadaEn };
          }
        }

        lookups.set(row.fila, { juego, pieza, globalDuplicado });
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
  // Solo para filas "nueva" con matchedDuplicado: true = vincular la pieza
  // ya existente en vez de crear una nueva. Por defecto false (sigue
  // creando nueva, igual que antes de este cambio) — nunca vincula sin que
  // el usuario lo elija fila por fila o con "Marcar todos".
  const [linkExistingChoices, setLinkExistingChoices] = useState<Map<number, boolean>>(new Map());
  const [validateProgress, setValidateProgress] = useState<Progress>({ done: 0, total: 0 });
  const [commitProgress, setCommitProgress] = useState<Progress>({ done: 0, total: 0 });
  const [backupProgress, setBackupProgress] = useState<BackupProgress | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [lastBatch, setLastBatch] = useState<PiezaImportBatch | null>(null);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [undoDone, setUndoDone] = useState<number | null>(null);
  // Filtro de solo vista de la tabla de revisión — no cambia qué filas se
  // procesan al confirmar, solo cuáles se listan (mismo patrón que
  // "Mostrar solo cambios de nombre" en CorreccionImportPanel.tsx).
  const [statusFilter, setStatusFilter] = useState<"todas" | ClassifiedPiezaRow["status"]>("todas");

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
    setLinkExistingChoices(new Map());
    setSummary(null);
    setStatusFilter("todas");
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
    const linkExisting = new Map<number, boolean>();
    for (const row of classified) {
      if (row.status === "actualizar" || row.status === "sin-relacion") overwrite.set(row.fila, false);
      if (row.status === "nueva" && row.matchedDuplicado) linkExisting.set(row.fila, false);
    }
    setOverwriteChoices(overwrite);
    setLinkExistingChoices(linkExisting);
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

  // Corre la importación de una vez, omitiendo repetidas (actualizar) y sin
  // relación — no alcanza con solo "preparar" el mapa de omisión con
  // markAllOfStatus, porque esas dos categorías ya arrancan omitidas por
  // defecto: tocar el botón no cambiaba nada visible y el usuario igual
  // tenía que bajar a tocar "Confirmar importación" aparte. Se calcula el
  // mapa "solo nuevo" al toque (no vía setState, que es asíncrono) y se le
  // pasa directo a handleConfirm.
  function importOnlyNuevas() {
    const overwrite = new Map(overwriteChoices);
    for (const row of rows) {
      if (row.status === "actualizar" || row.status === "sin-relacion") overwrite.set(row.fila, false);
    }
    setOverwriteChoices(overwrite);
    void handleConfirm(overwrite);
  }

  function setLinkExisting(fila: number, value: boolean) {
    setLinkExistingChoices((prev) => {
      const next = new Map(prev);
      next.set(fila, value);
      return next;
    });
  }

  function markAllLinkExisting(value: boolean) {
    setLinkExistingChoices((prev) => {
      const next = new Map(prev);
      for (const row of rows) {
        if (row.status === "nueva" && row.matchedDuplicado) next.set(row.fila, value);
      }
      return next;
    });
  }

  // `overwriteChoicesOverride` permite disparar la importación con un mapa
  // recién calculado en el mismo tick (ver importOnlyNuevas) sin depender
  // de que el setState de overwriteChoices ya se haya aplicado — React
  // batchea esas actualizaciones, así que leer el estado del componente
  // justo después de llamar a markAllOfStatus podría traer el valor viejo.
  async function handleConfirm(overwriteChoicesOverride?: Map<number, boolean>) {
    if (!user || !token) return;
    const actor = { id: user.id, token };
    const overwrite = overwriteChoicesOverride ?? overwriteChoices;
    setError(null);
    setPhase("backing-up");
    const backup = await runBackupNow(
      "BACKUP_PRE_IMPORTACION",
      "Captura masiva de piezas",
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

    let nuevas = 0;
    let actualizadas = 0;
    let vinculadas = 0;
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
      if ((row.status === "actualizar" || row.status === "sin-relacion") && !(overwrite.get(row.fila) ?? false)) {
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
        const linkToDuplicado =
          !existing && row.matchedDuplicado && (linkExistingChoices.get(row.fila) ?? false)
            ? row.matchedDuplicado.pieza
            : null;
        if (existing) {
          await importPiezaRow(actor, juegoId, existing.id, input, 0);
          actualizadas += 1;
        } else if (linkToDuplicado) {
          // La pieza ya existe en el catálogo (en otro juego, o sin
          // ninguno) y el usuario eligió reutilizarla en vez de crear una
          // duplicada — se actualiza con lo que traiga la fila y se liga a
          // este juego (importPiezaRow inserta el vínculo si todavía no
          // existía). No cuenta como "creada": el undo de la importación no
          // debe borrar una pieza que ya existía antes de esta corrida.
          const orden = juegoId === null ? 0 : (row.orden ?? (await nextOrden(juegoId)));
          await importPiezaRow(actor, juegoId, linkToDuplicado.id, input, orden);
          vinculadas += 1;
        } else {
          // Si la fila trae su propia posición (formato "Desglose"), se
          // respeta — así una pieza nueva agregada durante una depuración
          // externa queda en el mismo lugar que tenía en el archivo.
          const orden = juegoId === null ? 0 : (row.orden ?? (await nextOrden(juegoId)));
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
      vinculadas,
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
      `Captura masiva de piezas: ${nuevas} nuevas, ${actualizadas} actualizadas, ${vinculadas} vinculadas a pieza existente, ${omitidas} omitidas, ${conErrores} con errores, ${imagenesFallidas} imágenes no descargadas (total ${rows.length}).`,
    );
    setPhase("done");
    loadLastBatch();
  }

  const nuevasCount = rows.filter((r) => r.status === "nueva").length;
  const actualizarCount = rows.filter((r) => r.status === "actualizar").length;
  const sinRelacionCount = rows.filter((r) => r.status === "sin-relacion").length;
  const erroresCount = rows.filter((r) => r.status === "error").length;
  const duplicadosCount = rows.filter((r) => r.status === "nueva" && r.matchedDuplicado).length;
  // Filtro de solo vista — no cambia qué filas se procesan al confirmar, solo cuáles se listan.
  const displayedRows = statusFilter === "todas" ? rows : rows.filter((r) => r.status === statusFilter);

  return (
    <div>
      <h2>Captura masiva de piezas</h2>
      <p className="hint" style={{ marginTop: "0.4rem" }}>
        Acepta dos formatos de Excel (.xlsx). El del proveedor, agrupado por bloques: una fila con
        SKU sin guion (ej. "1138") es un juego; las filas siguientes son sus piezas, tengan o no su
        propio SKU (ej. "1138-1"), hasta la próxima fila de juego. Si ese juego no existe todavía en
        el catálogo (o una fila de pieza aparece antes de cualquier juego), tú decides en la
        revisión si esa pieza se importa igual sin relacionarla — la importación nunca crea juegos
        nuevos. Las imágenes se descargan automáticamente desde el link (Google Drive/Photos). O el
        export de "Exportar a Excel" de SKU Master (hoja "Desglose", detectada por su nombre),
        depurado en Excel y reimportado: una fila plana por pieza con el juego en cada una, sin
        imágenes. Ahí, si la fila no trae SKU propio, además del nombre se usa la posición dentro
        del juego para reencontrar la pieza — así una corrección de SKU o de nombre hecha en Excel
        se aplica sobre la pieza correcta en vez de crear una duplicada.
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
            <span className="tag">{actualizarCount} repetida(s) (ya existen en el catálogo)</span>
            <span className="tag">{sinRelacionCount} sin relación con un juego</span>
            <span className="tag">{erroresCount} con error</span>
            {duplicadosCount > 0 && (
              <span className="tag">{duplicadosCount} nueva(s) con posible duplicado en el catálogo</span>
            )}
            <span className="tag">{rows.length} fila(s) en total</span>
          </div>

          <div className="import-review-actions">
            <button type="button" className="btn btn-primary" onClick={importOnlyNuevas}>
              Importar solo lo nuevo ({nuevasCount})
            </button>
            <span className="hint" style={{ margin: 0 }}>
              Corre la importación ahora mismo (con su backup previo), creando solo las{" "}
              {nuevasCount} nueva(s) y omitiendo las {actualizarCount} repetida(s) y las{" "}
              {sinRelacionCount} sin relación — sin importar lo que hayas marcado más abajo.
            </span>
          </div>

          <p className="hint" style={{ margin: 0 }}>
            Actualizar reemplaza Origen/Descripción/Dimensiones/Peso/Maquila/Costo/Componentes de
            fabricación/Dimensiones de empaque de esa pieza con lo que traiga el Excel. Color,
            Material y Tipo de empaque solo se reemplazan si la fila trae un valor — vacíos no
            borran lo que la pieza ya tenía. La imagen solo se reemplaza si el link de esa fila se
            pudo descargar (el formato "Desglose" no trae imágenes). Las filas "Sin relación" no
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

          {duplicadosCount > 0 && (
            <>
              <p className="hint" style={{ margin: 0 }}>
                Estas {duplicadosCount} fila(s) serían "Nueva" dentro de su propio juego, pero
                coinciden por SKU o por nombre con una pieza que ya existe en el catálogo (en otro
                juego, o sin ninguno). No se vinculan solas — un nombre o SKU repetido no siempre es
                la misma pieza física. Revisá la columna "Motivo" antes de vincular en bloque.
              </p>
              <div className="import-review-actions">
                <span className="hint" style={{ margin: 0 }}>Para nuevas con posible duplicado:</span>
                <button type="button" className="btn btn-secondary" onClick={() => markAllLinkExisting(true)}>
                  Marcar todos: Vincular a pieza existente
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => markAllLinkExisting(false)}>
                  Marcar todos: Crear nueva
                </button>
              </div>
            </>
          )}

          <div className="import-review-actions">
            <span className="hint" style={{ margin: 0 }}>Mostrar en la tabla:</span>
            <button
              type="button"
              className={`filter-chip${statusFilter === "todas" ? " filter-chip-active" : ""}`}
              onClick={() => setStatusFilter("todas")}
            >
              Todas ({rows.length})
            </button>
            <button
              type="button"
              className={`filter-chip${statusFilter === "nueva" ? " filter-chip-active" : ""}`}
              onClick={() => setStatusFilter("nueva")}
            >
              Nuevas ({nuevasCount})
            </button>
            <button
              type="button"
              className={`filter-chip${statusFilter === "actualizar" ? " filter-chip-active" : ""}`}
              onClick={() => setStatusFilter("actualizar")}
            >
              Repetidas ({actualizarCount})
            </button>
            <button
              type="button"
              className={`filter-chip${statusFilter === "sin-relacion" ? " filter-chip-active" : ""}`}
              onClick={() => setStatusFilter("sin-relacion")}
            >
              Sin relación ({sinRelacionCount})
            </button>
            <button
              type="button"
              className={`filter-chip${statusFilter === "error" ? " filter-chip-active" : ""}`}
              onClick={() => setStatusFilter("error")}
            >
              Con error ({erroresCount})
            </button>
          </div>

          <div className="import-review-table-wrap">
            <table className="import-review-table">
              <thead>
                <tr>
                  <th>Fila</th>
                  <th>SKU</th>
                  <th>Pieza</th>
                  <th>Juego</th>
                  <th>Imagen</th>
                  <th>Estado</th>
                  <th>Acción</th>
                  <th>Motivo</th>
                </tr>
              </thead>
              <tbody>
                {displayedRows.map((row) => (
                  <tr key={row.fila}>
                    <td>{row.fila}</td>
                    <td>{row.sku || "—"}</td>
                    <td>{pieceName(row) || "—"}</td>
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
                      ) : row.status === "nueva" && row.matchedDuplicado ? (
                        <div className="import-overwrite-cell">
                          <div className="import-review-actions">
                            <button
                              type="button"
                              className={`filter-chip${linkExistingChoices.get(row.fila) ? " filter-chip-active" : ""}`}
                              onClick={() => setLinkExisting(row.fila, true)}
                            >
                              Vincular a pieza existente
                            </button>
                            <button
                              type="button"
                              className={`filter-chip${!linkExistingChoices.get(row.fila) ? " filter-chip-active" : ""}`}
                              onClick={() => setLinkExisting(row.fila, false)}
                            >
                              Crear nueva
                            </button>
                          </div>
                          <span className="import-overwrite-status">
                            {linkExistingChoices.get(row.fila)
                              ? "Se vinculará la pieza existente a este juego (se actualiza con lo que traiga esta fila)."
                              : "Se creará una pieza nueva, aunque ya exista una parecida."}
                          </span>
                        </div>
                      ) : row.status === "nueva" ? (
                        "Se creará"
                      ) : (
                        "Se omitirá"
                      )}
                    </td>
                    <td className="import-review-motivo">
                      {row.status === "nueva" && row.matchedDuplicado ? (
                        <>
                          Coincide por {row.matchedDuplicado.matchedBy === "sku" ? "SKU" : "nombre"} con
                          la pieza existente "{row.matchedDuplicado.pieza.nombre}"
                          {row.matchedDuplicado.pieza.sku ? ` (SKU ${row.matchedDuplicado.pieza.sku})` : ""}.{" "}
                          {row.matchedDuplicado.usadaEn.length > 0
                            ? `Ya se usa en: ${row.matchedDuplicado.usadaEn.map((p) => `${p.codigo} — ${p.nombre}`).join(", ")}.`
                            : "No está ligada a ningún juego todavía."}
                        </>
                      ) : (
                        (row.reason ?? "—")
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {displayedRows.length === 0 && (
              <p className="hint" style={{ margin: "0.5rem 0" }}>
                Ninguna fila coincide con este filtro.
              </p>
            )}
          </div>

          {error && <p className="form-error">{error}</p>}

          <div className="form-actions">
            <button type="button" className="btn btn-primary" onClick={() => handleConfirm()}>
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
              <span>{summary.vinculadas}</span>
              <span>Vinculados a pieza existente</span>
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
