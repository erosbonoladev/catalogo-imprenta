import { useEffect, useState } from "react";
import type { PrintItem, PrintItemOrder, Product } from "../types";
import { getPrintItemOrders } from "../db";
import ProduccionForm from "./ProduccionForm";
import CompraForm from "./CompraForm";

interface Props {
  product: Product;
  items: PrintItem[];
  onClose: () => void;
}

type Mode = "produccion" | "compra";

export default function OrderModal({ product, items, onClose }: Props) {
  const [mode, setMode] = useState<Mode>("produccion");
  const [ordersByItem, setOrdersByItem] = useState<Record<number, PrintItemOrder[]>>({});
  const [loadingOrders, setLoadingOrders] = useState(true);

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
            <div className="order-modal-items">
              {items.map((item) => (
                <CompraForm
                  key={item.id}
                  product={product}
                  item={item}
                  orders={ordersByItem[item.id as number] ?? []}
                  multi={items.length > 1}
                />
              ))}
            </div>
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
