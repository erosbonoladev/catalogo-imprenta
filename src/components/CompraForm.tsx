import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import type { PrintItem, PrintItemOrder, PrintItemPurchase, Product } from "../types";
import { createFolio, createPrintItemPurchase, getPrintItemPurchases, logEvent } from "../db";
import { useAuth } from "../auth";
import { buildPurchasePdf } from "../pdf";

interface Props {
  product: Product;
  item: PrintItem;
  orders: PrintItemOrder[];
  multi: boolean;
  refreshKey?: number;
}

const NUMERIC_RE = /^\d+(\.\d+)?$/;

function isPureNumber(value: string): boolean {
  return NUMERIC_RE.test(value.trim());
}

export default function CompraForm({ product, item, orders, multi, refreshKey }: Props) {
  const { user } = useAuth();
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(orders[0]?.id ?? null);
  const [cortesOverride, setCortesOverride] = useState("");
  const [purchases, setPurchases] = useState<PrintItemPurchase[]>([]);
  const [loadingPurchases, setLoadingPurchases] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!selectedOrderId) return;
    setLoadingPurchases(true);
    getPrintItemPurchases(selectedOrderId).then((list) => {
      setPurchases(list);
      setLoadingPurchases(false);
    });
  }, [selectedOrderId, refreshKey]);

  if (orders.length === 0) {
    return (
      <div className="order-modal-item">
        {multi && <h3>{item.nombre || "(sin nombre)"}</h3>}
        <p className="hint">
          Aún no se ha generado una orden de Producción para este ítem. Genera una en la pestaña
          Producción primero.
        </p>
      </div>
    );
  }

  const selectedOrder = orders.find((o) => o.id === selectedOrderId) ?? orders[0];
  const cortesValido = isPureNumber(item.cortes_tamano);
  const cortesNum = cortesValido ? parseFloat(item.cortes_tamano) : parseFloat(cortesOverride);
  const cortesListo = Number.isFinite(cortesNum) && cortesNum > 0;
  const cantidad = cortesListo ? Math.ceil(selectedOrder.total_pliegos / cortesNum) : null;
  const totalTamanos = cantidad !== null ? Math.ceil(cantidad * cortesNum) : null;

  async function handleSave() {
    if (!selectedOrder || cantidad === null || totalTamanos === null) return;
    setError(null);
    setSaving(true);
    try {
      const folio = await createFolio("compra", product.codigo);
      const pdfBytes = await buildPurchasePdf(
        product,
        [
          {
            item,
            baseOrder: selectedOrder,
            papel: item.tipo_papel,
            pliego: item.pliego,
            maquina: item.maquina,
            cortes: cortesNum,
            cantidad,
            totalTamanos,
          },
        ],
        folio.folio,
      );
      const defaultPath = `${folio.folio}.pdf`;

      const path = await save({
        title: "Guardar orden de compra",
        defaultPath,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!path) {
        setSaving(false);
        return;
      }
      await writeFile(path, pdfBytes);

      const purchase = await createPrintItemPurchase(
        selectedOrder.id,
        {
          papel: item.tipo_papel,
          pliego: item.pliego,
          maquina: item.maquina,
          cortes: cortesNum,
          cantidad,
          totalTamanos,
          folio: folio.folio,
        },
        user?.username,
      );
      setPurchases((prev) => [purchase, ...prev]);
      setSuccess(true);
    } catch (err) {
      setError(`No se pudo guardar la compra: ${String(err)}`);
      logEvent(
        "ERROR",
        `No se pudo guardar la Compra del ítem ${item.id}: ${String(err)}`,
        user?.username ?? null,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="order-modal-item">
      {multi && <h3>{item.nombre || "(sin nombre)"}</h3>}

      <label>
        Orden de producción base
        <select
          value={selectedOrder.id}
          onChange={(e) => {
            setSelectedOrderId(Number(e.target.value));
            setSuccess(false);
          }}
        >
          {orders.map((o) => (
            <option key={o.id} value={o.id}>
              {new Date(o.creado_en.includes("T") ? o.creado_en : `${o.creado_en.replace(" ", "T")}Z`).toLocaleString("es-MX")}
              {" — Total: "}
              {o.total_pliegos} pliegos
            </option>
          ))}
        </select>
      </label>

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
          <span className="print-item-view-field-value">{item.tipo_papel || "—"}</span>
        </div>

        <div className="print-item-view-field">
          <span className="print-item-view-field-label">Pliego</span>
          <span className="print-item-view-field-value">{item.pliego || "—"}</span>
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
              onChange={(e) => {
                setCortesOverride(e.target.value);
                setSuccess(false);
              }}
            />
          </label>
        )}

        <div className="print-item-view-field">
          <span className="print-item-view-field-label">Máquina</span>
          <span className="print-item-view-field-value">{item.maquina || "—"}</span>
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
      {success && <p className="hint">Compra guardada y PDF generado.</p>}

      <div className="form-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleSave}
          disabled={saving || cantidad === null}
        >
          {saving ? "Generando…" : "Generar PDF"}
        </button>
      </div>

      {!loadingPurchases && purchases.length > 0 && (
        <div className="print-item-history">
          <span className="print-item-checks-label">Compras registradas para esta orden</span>
          {purchases.map((p) => (
            <div className="print-item-history-order" key={p.id}>
              <div className="print-item-view-fields">
                <div className="print-item-view-field">
                  <span className="print-item-view-field-label">Papel</span>
                  <span className="print-item-view-field-value">{p.papel || "—"}</span>
                </div>
                <div className="print-item-view-field">
                  <span className="print-item-view-field-label">Pliego</span>
                  <span className="print-item-view-field-value">{p.pliego || "—"}</span>
                </div>
                <div className="print-item-view-field">
                  <span className="print-item-view-field-label">Cortes</span>
                  <span className="print-item-view-field-value">{p.cortes}</span>
                </div>
                <div className="print-item-view-field">
                  <span className="print-item-view-field-label">Máquina</span>
                  <span className="print-item-view-field-value">{p.maquina || "—"}</span>
                </div>
                <div className="print-item-view-field">
                  <span className="print-item-view-field-label">Cantidad</span>
                  <span className="print-item-view-field-value">{p.cantidad}</span>
                </div>
                <div className="print-item-view-field">
                  <span className="print-item-view-field-label">Total de tamaños</span>
                  <span className="print-item-view-field-value">{p.total_tamanos}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
