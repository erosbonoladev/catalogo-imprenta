import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import type { PrintItem, PrintItemOrder, Product } from "../types";
import { allowFsPath, createFolio, createPrintItemPurchase, getPrintItemOrders, logEvent } from "../db";
import { useAuth } from "../auth";
import { buildPurchasePdf } from "../pdf";
import type { PurchaseEntry } from "../pdf";
import ProduccionForm from "./ProduccionForm";
import CompraForm from "./CompraForm";

interface Props {
  product: Product;
  items: PrintItem[];
  onClose: () => void;
}

type Mode = "produccion" | "compra";

const NUMERIC_RE = /^\d+(\.\d+)?$/;

function isPureNumber(value: string): boolean {
  return NUMERIC_RE.test(value.trim());
}

export default function OrderModal({ product, items, onClose }: Props) {
  const { user, token } = useAuth();
  const [mode, setMode] = useState<Mode>("produccion");
  const [ordersByItem, setOrdersByItem] = useState<Record<number, PrintItemOrder[]>>({});
  const [loadingOrders, setLoadingOrders] = useState(true);
  const [generalSaving, setGeneralSaving] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [generalSuccess, setGeneralSuccess] = useState(false);
  const [compraRefreshKey, setCompraRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        items.map(
          async (item) =>
            [item.id as number, await getPrintItemOrders(item.id as number)] as const,
        ),
      );
      if (cancelled) return;
      setOrdersByItem(Object.fromEntries(entries));
      setLoadingOrders(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [items]);

  function addOrder(printItemId: number, order: PrintItemOrder) {
    setOrdersByItem((prev) => ({
      ...prev,
      [printItemId]: [order, ...(prev[printItemId] ?? [])],
    }));
  }

  async function handleGeneralCompraPdf() {
    setGeneralError(null);
    setGeneralSuccess(false);
    const entries: PurchaseEntry[] = [];

    for (const item of items) {
      const orders = ordersByItem[item.id as number] ?? [];
      if (orders.length === 0) {
        setGeneralError(
          `"${item.nombre || "(sin nombre)"}": aún no tiene una orden de Producción generada — créala en la pestaña Producción primero.`,
        );
        return;
      }
      const baseOrder = orders[0];
      if (!isPureNumber(item.cortes_tamano)) {
        setGeneralError(
          `"${item.nombre || "(sin nombre)"}": el valor de Cortes ("${item.cortes_tamano || "—"}") no es numérico — genera la compra de este ítem individualmente para poder ingresar el valor a usar.`,
        );
        return;
      }
      const cortes = parseFloat(item.cortes_tamano);
      const cantidad = Math.ceil(baseOrder.total_pliegos / cortes);
      const totalTamanos = Math.ceil(cantidad * cortes);
      entries.push({
        item,
        baseOrder,
        papel: item.tipo_papel,
        pliego: item.pliego,
        maquina: item.maquina,
        cortes,
        cantidad,
        totalTamanos,
      });
    }

    if (!user || !token) return;
    const actor = { id: user.id, token };
    setGeneralSaving(true);
    try {
      const folio = await createFolio("compra", product.codigo);
      const pdfBytes = await buildPurchasePdf(product, entries, folio.folio);
      const defaultPath = `${folio.folio}.pdf`;

      const path = await save({
        title: "Guardar orden de compra general",
        defaultPath,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!path) {
        setGeneralSaving(false);
        return;
      }
      await allowFsPath(path);
      await writeFile(path, pdfBytes);

      for (const entry of entries) {
        try {
          await createPrintItemPurchase(
            actor,
            entry.baseOrder.id,
            {
              papel: entry.papel,
              pliego: entry.pliego,
              maquina: entry.maquina,
              cortes: entry.cortes,
              cantidad: entry.cantidad,
              totalTamanos: entry.totalTamanos,
              folio: folio.folio,
            },
            user?.username,
          );
        } catch (err) {
          logEvent(
            "ERROR",
            `No se pudo guardar la compra general del ítem ${entry.item.id}: ${String(err)}`,
            user?.username ?? null,
          );
        }
      }

      setCompraRefreshKey((k) => k + 1);
      setGeneralSuccess(true);
    } catch (err) {
      setGeneralError(`No se pudo generar el PDF: ${String(err)}`);
    } finally {
      setGeneralSaving(false);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        <h2>
          {items.length > 1 ? "Crear orden general" : `Crear orden: ${items[0].nombre || "(sin nombre)"}`}
        </h2>

        <div className="order-modal-tabs" role="group" aria-label="Tipo de orden">
          <button
            type="button"
            className={`filter-chip${mode === "produccion" ? " filter-chip-active" : ""}`}
            onClick={() => setMode("produccion")}
          >
            PRODUCCIÓN
          </button>
          <button
            type="button"
            className={`filter-chip${mode === "compra" ? " filter-chip-active" : ""}`}
            onClick={() => setMode("compra")}
          >
            COMPRA
          </button>
        </div>

        {mode === "produccion" && (
          <ProduccionForm
            product={product}
            items={items}
            onOrderCreated={addOrder}
            onSwitchToCompra={() => setMode("compra")}
          />
        )}

        {mode === "compra" &&
          (loadingOrders ? (
            <p className="hint">Cargando…</p>
          ) : (
            <>
              {items.length > 1 && (
                <div className="order-modal-item">
                  <p className="hint">
                    Genera una sola orden de compra en PDF para todos los ítems de esta lista,
                    usando la orden de Producción más reciente de cada uno.
                  </p>
                  {generalError && <p className="form-error">{generalError}</p>}
                  {generalSuccess && <p className="hint">Compra general guardada y PDF generado.</p>}
                  <div className="form-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={handleGeneralCompraPdf}
                      disabled={generalSaving}
                    >
                      {generalSaving ? "Generando…" : "Crear PDF de orden general de compra"}
                    </button>
                  </div>
                </div>
              )}
              <div className="order-modal-items">
                {items.map((item) => (
                  <CompraForm
                    key={item.id}
                    product={product}
                    item={item}
                    orders={ordersByItem[item.id as number] ?? []}
                    multi={items.length > 1}
                    refreshKey={compraRefreshKey}
                  />
                ))}
              </div>
            </>
          ))}

        <div className="form-actions">
          <button className="btn btn-secondary" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
