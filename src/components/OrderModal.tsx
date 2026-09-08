import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import type { PrintItem, PrintItemOrder, Product } from "../types";
import {
  allowFsPath,
  createFolio,
  createPrintItemPurchasesBatch,
  getPrintItemOrders,
  logEventAsActor,
} from "../db";
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
  const [ordersLoadError, setOrdersLoadError] = useState<string | null>(null);
  const [generalSaving, setGeneralSaving] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [generalSuccess, setGeneralSuccess] = useState(false);
  // Se llena cuando las compras YA quedaron guardadas en la BD (atómico, todo
  // o nada) pero el PDF todavía no se guardó (diálogo cancelado o falló la
  // escritura) — permite reintentar solo el PDF sin volver a insertar los
  // registros, que ya existen.
  const [pdfPending, setPdfPending] = useState<{ folio: string; entries: PurchaseEntry[] } | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [compraRefreshKey, setCompraRefreshKey] = useState(0);

  function loadOrders() {
    let cancelled = false;
    setLoadingOrders(true);
    setOrdersLoadError(null);
    (async () => {
      try {
        const entries = await Promise.all(
          items.map(
            async (item) =>
              [item.id as number, await getPrintItemOrders(item.id as number)] as const,
          ),
        );
        if (cancelled) return;
        setOrdersByItem(Object.fromEntries(entries));
      } catch (err) {
        if (!cancelled) setOrdersLoadError(`No se pudieron cargar las órdenes: ${String(err)}`);
      } finally {
        if (!cancelled) setLoadingOrders(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }

  useEffect(() => {
    const cancel = loadOrders();
    return cancel;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  function addOrder(printItemId: number, order: PrintItemOrder) {
    setOrdersByItem((prev) => ({
      ...prev,
      [printItemId]: [order, ...(prev[printItemId] ?? [])],
    }));
  }

  // Construye y guarda el PDF de una compra general ya persistida en BD — se
  // llama tanto al terminar de guardar como al reintentar desde pdfPending,
  // sin volver a tocar la BD en ningún caso (las compras ya existen).
  async function trySavePdf(folio: string, entries: PurchaseEntry[]) {
    try {
      const pdfBytes = await buildPurchasePdf(product, entries, folio);
      const path = await save({
        title: "Guardar orden de compra general",
        defaultPath: `${folio}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!path) {
        // Cancelar el diálogo no es un error: las compras ya están guardadas,
        // solo falta el PDF — se deja pdfPending para reintentar cuando quiera.
        setPdfPending({ folio, entries });
        return;
      }
      await allowFsPath(path);
      await writeFile(path, pdfBytes);
      setPdfPending(null);
      setPdfError(null);
      setGeneralSuccess(true);
    } catch (err) {
      setPdfPending({ folio, entries });
      setPdfError(`Las compras ya se guardaron, pero no se pudo generar/guardar el PDF: ${String(err)}`);
    }
  }

  async function handleRetryPdf() {
    if (!pdfPending) return;
    setGeneralSaving(true);
    try {
      await trySavePdf(pdfPending.folio, pdfPending.entries);
    } finally {
      setGeneralSaving(false);
    }
  }

  async function handleGeneralCompraPdf() {
    setGeneralError(null);
    setGeneralSuccess(false);
    setPdfPending(null);
    setPdfError(null);
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
      if (!(cortes > 0)) {
        setGeneralError(
          `"${item.nombre || "(sin nombre)"}": el valor de Cortes debe ser mayor a 0 — genera la compra de este ítem individualmente para poder ingresar el valor a usar.`,
        );
        return;
      }
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

      // Todo o nada: si una sola compra falla, ninguna queda guardada — así
      // nunca se reporta éxito (ni se genera un PDF) con registros faltantes.
      try {
        await createPrintItemPurchasesBatch(
          actor,
          entries.map((entry) => ({
            printItemOrderId: entry.baseOrder.id,
            papel: entry.papel,
            pliego: entry.pliego,
            maquina: entry.maquina,
            cortes: entry.cortes,
            cantidad: entry.cantidad,
            totalTamanos: entry.totalTamanos,
            folio: folio.folio,
          })),
        );
      } catch (err) {
        setGeneralError(`No se pudieron guardar las compras: ${String(err)}`);
        logEventAsActor(actor, "ERROR", `Falló la compra general (nada quedó guardado): ${String(err)}`);
        return;
      }

      setCompraRefreshKey((k) => k + 1);
      await trySavePdf(folio.folio, entries);
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
          ) : ordersLoadError ? (
            <>
              <p className="form-error">{ordersLoadError}</p>
              <button type="button" className="btn btn-secondary" onClick={loadOrders}>
                Reintentar
              </button>
            </>
          ) : (
            <>
              {items.length > 1 && (
                <div className="order-modal-item">
                  <p className="hint">
                    Genera una sola orden de compra en PDF para todos los ítems de esta lista,
                    usando la orden de Producción más reciente de cada uno.
                  </p>
                  {generalError && <p className="form-error">{generalError}</p>}
                  {pdfError && <p className="form-error">{pdfError}</p>}
                  {pdfPending && !pdfError && (
                    <p className="hint">Las compras ya se guardaron — falta guardar el PDF.</p>
                  )}
                  {generalSuccess && <p className="hint">Compra general guardada y PDF generado.</p>}
                  <div className="form-actions">
                    {pdfPending ? (
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={handleRetryPdf}
                        disabled={generalSaving}
                      >
                        {generalSaving ? "Guardando…" : "Guardar PDF"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={handleGeneralCompraPdf}
                        disabled={generalSaving}
                      >
                        {generalSaving ? "Generando…" : "Crear PDF de orden general de compra"}
                      </button>
                    )}
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
