import { useEffect, useState } from "react";
import { getPreciosBySkuPrincipal, upsertPrecio } from "../db";
import { computeSkuPrincipal } from "../precios";
import { formatMoney } from "../excelExport";
import type { Precio, Product } from "../types";
import { hasPermission, useAuth } from "../auth";
import Toast from "./Toast";

interface Props {
  product: Product;
  onClose: () => void;
}

function formatFechaCorta(fechaSql: string): string {
  const [fecha] = fechaSql.split(" ");
  const [y, m, d] = fecha.split("-");
  if (!y || !m || !d) return fechaSql;
  return `${d}/${m}/${y}`;
}

export default function PreciosModal({ product, onClose }: Props) {
  const { user } = useAuth();
  const canVer = hasPermission(user, "precios_ver");
  const canModificar = hasPermission(user, "precios_modificar");

  const [precios, setPrecios] = useState<Precio[] | null>(null);
  const [editValues, setEditValues] = useState<Map<string, string>>(new Map());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!canVer) return;
    let cancelled = false;
    (async () => {
      const skuPrincipal = computeSkuPrincipal(product.codigo);
      const list = await getPreciosBySkuPrincipal(skuPrincipal);
      if (!cancelled) setPrecios(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [canVer, product.codigo]);

  if (!canVer) {
    return (
      <div className="modal-overlay" role="dialog" aria-modal="true">
        <div className="modal-card">
          <h2>Precios</h2>
          <p className="hint">No tienes permiso para ver precios.</p>
          <div className="form-actions">
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Cerrar
            </button>
          </div>
        </div>
      </div>
    );
  }

  function setDraft(sku: string, value: string) {
    setEditValues((prev) => {
      const next = new Map(prev);
      next.set(sku, value);
      return next;
    });
  }

  const dirtySkus = [...editValues.keys()].filter((sku) => {
    const precio = precios?.find((p) => p.sku === sku);
    if (!precio) return false;
    // Comparar como número, no como texto: retipear "10.50" sobre un precio
    // guardado como 10.5 no debe contar como cambio real (evita un renglón
    // de precios_historial con precio_anterior === precio_nuevo).
    const draft = Number(editValues.get(sku));
    return !Number.isFinite(draft) || draft !== precio.precio;
  });

  async function handleGuardar() {
    if (!precios || dirtySkus.length === 0) return;
    setSaving(true);
    setError(null);

    // Validar todo antes de escribir nada — si una fila tiene un precio
    // inválido no queremos haber guardado ya la mitad de las otras filas.
    const toSave: { sku: string; nombre: string; precio: number }[] = [];
    for (const sku of dirtySkus) {
      const draft = editValues.get(sku) ?? "";
      const nuevoPrecio = Number(draft);
      if (!Number.isFinite(nuevoPrecio) || nuevoPrecio <= 0) {
        setError(`El precio de ${sku} debe ser un número mayor que 0.`);
        setSaving(false);
        return;
      }
      const existing = precios.find((p) => p.sku === sku);
      if (!existing) continue;
      toSave.push({ sku, nombre: existing.nombre, precio: nuevoPrecio });
    }

    try {
      // Renglones independientes — se guardan en paralelo en vez de uno por
      // uno esperando cada viaje de red.
      await Promise.all(
        toSave.map((item) =>
          upsertPrecio({
            sku: item.sku,
            nombre: item.nombre,
            precio: item.precio,
            usuario: user?.username ?? null,
          }),
        ),
      );
      const skuPrincipal = computeSkuPrincipal(product.codigo);
      const refreshed = await getPreciosBySkuPrincipal(skuPrincipal);
      setPrecios(refreshed);
      setEditValues(new Map());
      setToastMessage("Precios actualizados.");
    } catch (err) {
      setError(`No se pudieron guardar los cambios: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        <h2>Precios — {product.nombre}</h2>

        {precios === null ? (
          <p className="hint">Cargando…</p>
        ) : precios.length === 0 ? (
          <p className="hint">No hay precios registrados para este producto.</p>
        ) : (
          <div className="import-review-table-wrap">
            <table className="import-review-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Producto</th>
                  <th>Precio</th>
                  <th>Fecha de modificación</th>
                </tr>
              </thead>
              <tbody>
                {precios.map((p) => (
                  <tr key={p.sku}>
                    <td>{p.sku}</td>
                    <td>{p.nombre}</td>
                    <td>
                      {canModificar ? (
                        <input
                          type="text"
                          inputMode="decimal"
                          value={editValues.get(p.sku) ?? String(p.precio)}
                          onChange={(e) => setDraft(p.sku, e.target.value)}
                          disabled={saving}
                          style={{ width: "6rem" }}
                        />
                      ) : (
                        formatMoney(p.precio)
                      )}
                    </td>
                    <td>{formatFechaCorta(p.actualizado_en)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {error && <p className="form-error">{error}</p>}

        <div className="form-actions">
          {canModificar && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving || dirtySkus.length === 0}
              onClick={handleGuardar}
            >
              {saving ? "Guardando…" : "Guardar cambios"}
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Cerrar
          </button>
        </div>
      </div>

      <Toast message={toastMessage ?? ""} show={!!toastMessage} onHide={() => setToastMessage(null)} />
    </div>
  );
}
