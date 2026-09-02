import { useEffect, useState } from "react";
import { getRemisionRenglones } from "../db";
import { formatMoney } from "../excelExport";
import type { Remision, RemisionRenglon } from "../types";

interface Props {
  remision: Remision;
  onClose: () => void;
}

function formatFechaCorta(fechaIso: string): string {
  const [y, m, d] = fechaIso.split("-");
  if (!y || !m || !d) return fechaIso;
  return `${d}/${m}/${y}`;
}

export default function RemisionDetalleModal({ remision, onClose }: Props) {
  const [renglones, setRenglones] = useState<RemisionRenglon[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await getRemisionRenglones(remision.id);
      if (!cancelled) setRenglones(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [remision.id]);

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        <h2>Remisión {remision.folio}</h2>
        <p className="hint">
          {formatFechaCorta(remision.fecha)} · Pedido: {remision.pedido_bodegas || "—"} ·{" "}
          {remision.cancelada ? "Cancelada" : "Activa"}
        </p>

        {renglones === null ? (
          <p className="hint">Cargando…</p>
        ) : (
          <div className="import-review-table-wrap">
            <table className="import-review-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Producto</th>
                  <th>Cantidad</th>
                  <th>Precio</th>
                  <th>Importe</th>
                </tr>
              </thead>
              <tbody>
                {renglones.map((r) => (
                  <tr key={r.id}>
                    <td>{r.sku}</td>
                    <td>{r.producto_nombre}</td>
                    <td>{r.cantidad}</td>
                    <td>{formatMoney(r.precio_unitario)}</td>
                    <td>{formatMoney(r.importe)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="remision-totales">
          <div className="form-row">
            <span>Subtotal</span>
            <strong>{formatMoney(remision.subtotal)}</strong>
          </div>
          <div className="form-row">
            <span>Descuento {remision.descuento_pct}%</span>
            <strong>{formatMoney(remision.descuento)}</strong>
          </div>
          <div className="form-row">
            <span>IVA 16%</span>
            <strong>{formatMoney(remision.iva)}</strong>
          </div>
          <div className="form-row">
            <span>Total</span>
            <strong>{formatMoney(remision.total)}</strong>
          </div>
          <p className="hint">Precio en texto: {remision.precio_texto}</p>
        </div>

        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
