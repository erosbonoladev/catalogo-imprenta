import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import type { PrintItem, PrintItemOrder, Product } from "../types";
import { allowFsPath, logEventAsActor, updatePrintItemOrder } from "../db";
import { buildOrderPdf } from "../pdf";
import type { OrderEntry } from "../pdf";
import { useAuth } from "../auth";

interface Props {
  product: Product;
  item: PrintItem;
  order: PrintItemOrder;
  onClose: () => void;
  onUpdated: (order: PrintItemOrder) => void;
}

const NUMERIC_RE = /^\d+(\.\d+)?$/;

function isPureNumber(value: string): boolean {
  return NUMERIC_RE.test(value.trim());
}

function parseSqlDate(iso: string): Date {
  return new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
}

export default function EditPrintOrderModal({ product, item, order, onClose, onUpdated }: Props) {
  const { user, token } = useAuth();
  const [merma, setMerma] = useState(String(order.merma));
  const [cantidadArte, setCantidadArte] = useState(String(order.cantidad_arte));
  const [numeroTiros, setNumeroTiros] = useState(String(order.numero_tiros ?? ""));

  const formacionValida = isPureNumber(item.formacion);
  const pliegosValidos = isPureNumber(item.numero_pliegos);
  const [formacionOverride, setFormacionOverride] = useState(
    formacionValida ? "" : String(order.formacion_usada),
  );
  const [numeroPliegosOverride, setNumeroPliegosOverride] = useState(
    pliegosValidos ? "" : String(order.numero_pliegos_usado),
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOrder, setSavedOrder] = useState<PrintItemOrder | null>(null);
  const [savingPdf, setSavingPdf] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  const mermaNum = parseFloat(merma);
  const cantidadArteNum = parseFloat(cantidadArte);
  const numeroTirosNum = parseFloat(numeroTiros);
  const formacionNum = formacionValida ? parseFloat(item.formacion) : parseFloat(formacionOverride);
  const pliegosNum = pliegosValidos ? parseFloat(item.numero_pliegos) : parseFloat(numeroPliegosOverride);

  const camposListos =
    [mermaNum, cantidadArteNum, formacionNum, pliegosNum].every(Number.isFinite) &&
    formacionNum > 0 &&
    pliegosNum > 0;
  const total = camposListos ? Math.ceil((cantidadArteNum / formacionNum + mermaNum) * pliegosNum) : null;
  const totalPorPliego = total !== null ? Math.ceil(total / pliegosNum) : null;

  async function trySavePdf(target: PrintItemOrder) {
    if (total === null || totalPorPliego === null) return;
    setPdfError(null);
    setSavingPdf(true);
    try {
      const entry: OrderEntry = {
        item,
        merma: mermaNum,
        cantidadArte: cantidadArteNum,
        numeroTiros: numeroTirosNum,
        totalPliegos: total,
        totalPorPliego,
      };
      const pdfBytes = await buildOrderPdf(product, [entry], target.folio, parseSqlDate(target.creado_en));
      const path = await save({
        title: "Guardar orden de impresión actualizada",
        defaultPath: `${target.folio}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!path) return;
      await allowFsPath(path);
      await writeFile(path, pdfBytes);
    } catch (err) {
      setPdfError(`La orden ya se guardó, pero no se pudo generar/guardar el PDF: ${String(err)}`);
    } finally {
      setSavingPdf(false);
    }
  }

  async function handleSave() {
    setError(null);
    if (!merma.trim() || !isPureNumber(merma)) {
      setError("Ingresa una Merma numérica válida.");
      return;
    }
    if (!cantidadArte.trim() || !isPureNumber(cantidadArte)) {
      setError("Ingresa una Cantidad de arte numérica válida.");
      return;
    }
    if (!numeroTiros.trim() || !isPureNumber(numeroTiros)) {
      setError("Ingresa un Número de tiros numérico válido.");
      return;
    }
    if (!formacionValida && (!formacionOverride.trim() || !isPureNumber(formacionOverride))) {
      setError(
        `La Formación registrada en la ficha ("${item.formacion}") no es un número; ingresa el valor numérico a usar.`,
      );
      return;
    }
    if (!(formacionNum > 0)) {
      setError("La Formación debe ser mayor a 0.");
      return;
    }
    if (!pliegosValidos && (!numeroPliegosOverride.trim() || !isPureNumber(numeroPliegosOverride))) {
      setError(
        `El Número de pliegos registrado en la ficha ("${item.numero_pliegos}") no es un número; ingresa el valor numérico a usar.`,
      );
      return;
    }
    if (!(pliegosNum > 0)) {
      setError("El Número de pliegos debe ser mayor a 0.");
      return;
    }
    if (!user || !token || total === null) return;
    const actor = { id: user.id, token };
    setSaving(true);
    try {
      const saved = await updatePrintItemOrder(actor, order.id, {
        merma: mermaNum,
        cantidadArte: cantidadArteNum,
        numeroTiros: numeroTirosNum,
        formacionUsada: formacionNum,
        numeroPliegosUsado: pliegosNum,
        totalPliegos: total,
      });
      setSavedOrder(saved);
      onUpdated(saved);
      logEventAsActor(actor, "INFO", `Orden de producción ${saved.folio} editada por ${user.username}`);
      await trySavePdf(saved);
    } catch (err) {
      setError(`No se pudo guardar la edición: ${String(err)}`);
      logEventAsActor(actor, "ERROR", `No se pudo editar la orden de producción #${order.id}: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        <h2>Editar orden de producción</h2>
        <p className="hint">
          {item.nombre || "(sin nombre)"} · Folio {order.folio} — el folio no cambia al editar.
        </p>

        <div className="calculated-field">
          <span className="calculated-field-label">
            Total de tamaños a imprimir con merma
            <span className="calculated-badge">Calculado</span>
          </span>
          <span className="calculated-field-value">{total ?? "—"}</span>
        </div>
        <div className="calculated-field" style={{ marginTop: "0.6rem" }}>
          <span className="calculated-field-label">
            Total de cambios por pliego a imprimir
            <span className="calculated-badge">Calculado</span>
          </span>
          <span className="calculated-field-value">{totalPorPliego ?? "—"}</span>
        </div>

        <div className="order-modal-fields" style={{ marginTop: "0.9rem" }}>
          <label>
            Merma
            <input
              type="number"
              min="0"
              step="any"
              value={merma}
              onChange={(e) => setMerma(e.target.value)}
              disabled={saving || !!savedOrder}
            />
          </label>
          <label>
            Cantidad de arte
            <input
              type="number"
              min="0"
              step="any"
              value={cantidadArte}
              onChange={(e) => setCantidadArte(e.target.value)}
              disabled={saving || !!savedOrder}
            />
          </label>
          <label>
            Número de tiros
            <input
              type="number"
              min="0"
              step="any"
              value={numeroTiros}
              onChange={(e) => setNumeroTiros(e.target.value)}
              disabled={saving || !!savedOrder}
            />
          </label>

          <div className="print-item-view-field">
            <span className="print-item-view-field-label">Formación</span>
            <span className="print-item-view-field-value">{item.formacion || "—"}</span>
          </div>
          {!formacionValida && (
            <label>
              Formación registrada: "{item.formacion || "—"}" — valor numérico a usar
              <input
                type="number"
                min="0"
                step="any"
                value={formacionOverride}
                onChange={(e) => setFormacionOverride(e.target.value)}
                disabled={saving || !!savedOrder}
              />
            </label>
          )}

          <div className="print-item-view-field">
            <span className="print-item-view-field-label">Número de pliegos</span>
            <span className="print-item-view-field-value">{item.numero_pliegos || "—"}</span>
          </div>
          {!pliegosValidos && (
            <label>
              Número de pliegos registrado: "{item.numero_pliegos || "—"}" — valor numérico a usar
              <input
                type="number"
                min="0"
                step="any"
                value={numeroPliegosOverride}
                onChange={(e) => setNumeroPliegosOverride(e.target.value)}
                disabled={saving || !!savedOrder}
              />
            </label>
          )}
        </div>

        {error && <p className="form-error">{error}</p>}
        {savedOrder && !error && <p className="hint">Cambios guardados.</p>}
        {pdfError && <p className="form-error">{pdfError}</p>}

        <div className="form-actions">
          {!savedOrder ? (
            <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? "Guardando…" : "Guardar cambios"}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => trySavePdf(savedOrder)}
              disabled={savingPdf}
            >
              {savingPdf ? "Guardando…" : "Guardar PDF"}
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            {savedOrder ? "Cerrar" : "Cancelar"}
          </button>
        </div>
      </div>
    </div>
  );
}
