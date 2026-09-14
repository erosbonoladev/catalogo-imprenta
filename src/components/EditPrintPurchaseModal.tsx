import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import type { PrintItem, PrintItemOrder, PrintItemPurchase, Product } from "../types";
import { allowFsPath, logEventAsActor, updatePrintItemPurchase } from "../db";
import { buildPurchasePdf } from "../pdf";
import type { PurchaseEntry } from "../pdf";
import { useAuth } from "../auth";

interface Props {
  product: Product;
  item: PrintItem;
  order: PrintItemOrder;
  purchase: PrintItemPurchase;
  onClose: () => void;
  onUpdated: (purchase: PrintItemPurchase) => void;
}

const NUMERIC_RE = /^\d+(\.\d+)?$/;

function isPureNumber(value: string): boolean {
  return NUMERIC_RE.test(value.trim());
}

function parseSqlDate(iso: string): Date {
  return new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
}

export default function EditPrintPurchaseModal({
  product,
  item,
  order,
  purchase,
  onClose,
  onUpdated,
}: Props) {
  const { user, token } = useAuth();
  const cortesValido = isPureNumber(item.cortes_tamano);
  const [cortesOverride, setCortesOverride] = useState(cortesValido ? "" : String(purchase.cortes));

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedPurchase, setSavedPurchase] = useState<PrintItemPurchase | null>(null);
  const [savingPdf, setSavingPdf] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  const cortesNum = cortesValido ? parseFloat(item.cortes_tamano) : parseFloat(cortesOverride);
  const cortesListo = Number.isFinite(cortesNum) && cortesNum > 0;
  const cantidad = cortesListo ? Math.ceil(order.total_pliegos / cortesNum) : null;
  const totalTamanos = cantidad !== null ? Math.ceil(cantidad * cortesNum) : null;

  async function trySavePdf(target: PrintItemPurchase) {
    if (cantidad === null || totalTamanos === null) return;
    setPdfError(null);
    setSavingPdf(true);
    try {
      const entry: PurchaseEntry = {
        item,
        baseOrder: order,
        papel: target.papel,
        pliego: target.pliego,
        maquina: target.maquina,
        cortes: cortesNum,
        cantidad,
        totalTamanos,
      };
      const pdfBytes = await buildPurchasePdf(product, [entry], target.folio, parseSqlDate(target.creado_en));
      const path = await save({
        title: "Guardar orden de compra actualizada",
        defaultPath: `${target.folio}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!path) return;
      await allowFsPath(path);
      await writeFile(path, pdfBytes);
    } catch (err) {
      setPdfError(`La compra ya se guardó, pero no se pudo generar/guardar el PDF: ${String(err)}`);
    } finally {
      setSavingPdf(false);
    }
  }

  async function handleSave() {
    setError(null);
    if (!cortesValido && (!cortesOverride.trim() || !isPureNumber(cortesOverride))) {
      setError(`El valor de Cortes ("${item.cortes_tamano || "—"}") no es numérico; ingresa el valor a usar.`);
      return;
    }
    if (!cortesListo || cantidad === null || totalTamanos === null) {
      setError("Cortes debe ser mayor a 0.");
      return;
    }
    if (!user || !token) return;
    const actor = { id: user.id, token };
    setSaving(true);
    try {
      const saved = await updatePrintItemPurchase(actor, purchase.id, {
        cortes: cortesNum,
        cantidad,
        totalTamanos,
      });
      setSavedPurchase(saved);
      onUpdated(saved);
      logEventAsActor(actor, "INFO", `Compra ${saved.folio} editada por ${user.username}`);
      await trySavePdf(saved);
    } catch (err) {
      setError(`No se pudo guardar la edición: ${String(err)}`);
      logEventAsActor(actor, "ERROR", `No se pudo editar la compra #${purchase.id}: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        <h2>Editar orden de compra</h2>
        <p className="hint">
          {item.nombre || "(sin nombre)"} · Folio {purchase.folio} — el folio no cambia al editar.
        </p>

        <div className="order-modal-fields" style={{ marginTop: "0.9rem" }}>
          <div className="calculated-field">
            <span className="calculated-field-label">
              Cantidad
              <span className="calculated-badge">Calculado</span>
            </span>
            <span className="calculated-field-value">{cantidad ?? "—"}</span>
          </div>

          <div className="print-item-view-field">
            <span className="print-item-view-field-label">Papel</span>
            <span className="print-item-view-field-value">{purchase.papel || "—"}</span>
          </div>
          <div className="print-item-view-field">
            <span className="print-item-view-field-label">Pliego</span>
            <span className="print-item-view-field-value">{purchase.pliego || "—"}</span>
          </div>

          {cortesValido ? (
            <div className="print-item-view-field">
              <span className="print-item-view-field-label">Cortes</span>
              <span className="print-item-view-field-value">{item.cortes_tamano}</span>
            </div>
          ) : (
            <label>
              Cortes registrado: "{item.cortes_tamano || "—"}" — valor numérico a usar
              <input
                type="number"
                min="0"
                step="any"
                value={cortesOverride}
                onChange={(e) => setCortesOverride(e.target.value)}
                disabled={saving || !!savedPurchase}
              />
            </label>
          )}

          <div className="print-item-view-field">
            <span className="print-item-view-field-label">Máquina</span>
            <span className="print-item-view-field-value">{purchase.maquina || "—"}</span>
          </div>

          <div className="calculated-field">
            <span className="calculated-field-label">
              Total de tamaños
              <span className="calculated-badge">Calculado</span>
            </span>
            <span className="calculated-field-value">{totalTamanos ?? "—"}</span>
          </div>
        </div>

        {error && <p className="form-error">{error}</p>}
        {savedPurchase && !error && <p className="hint">Cambios guardados.</p>}
        {pdfError && <p className="form-error">{pdfError}</p>}

        <div className="form-actions">
          {!savedPurchase ? (
            <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? "Guardando…" : "Guardar cambios"}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => trySavePdf(savedPurchase)}
              disabled={savingPdf}
            >
              {savingPdf ? "Guardando…" : "Guardar PDF"}
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            {savedPurchase ? "Cerrar" : "Cancelar"}
          </button>
        </div>
      </div>
    </div>
  );
}
