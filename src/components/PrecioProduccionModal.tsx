import { useEffect, useState } from "react";
import { getPrecioProduccion, savePrecioProduccion } from "../db";
import { parseAmount } from "../precios";
import { formatMoney } from "../excelExport";
import type { PrecioProduccion, Product } from "../types";
import { hasPermission, useAuth } from "../auth";
import Toast from "./Toast";

interface Props {
  product: Product;
  onClose: () => void;
}

function formatFechaCorta(fechaSql: string | null): string {
  if (!fechaSql) return "—";
  const [fecha] = fechaSql.split(" ");
  const [y, m, d] = fecha.split("-");
  if (!y || !m || !d) return fechaSql;
  return `${d}/${m}/${y}`;
}

export default function PrecioProduccionModal({ product, onClose }: Props) {
  const { user, token } = useAuth();
  const canVer = hasPermission(user, "precios_produccion_ver");
  const canModificar = hasPermission(user, "precios_produccion_modificar");

  const [precio, setPrecio] = useState<PrecioProduccion | null>(null);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!canVer || !user || !token) return;
    const actor = { id: user.id, token };
    let cancelled = false;
    (async () => {
      const p = await getPrecioProduccion(actor, product.id);
      if (!cancelled) setPrecio(p);
    })();
    return () => {
      cancelled = true;
    };
  }, [canVer, product.id, user, token]);

  if (!canVer) {
    return (
      <div className="modal-overlay" role="dialog" aria-modal="true">
        <div className="modal-card">
          <h2>Precio de Producción</h2>
          <p className="hint">No tienes permiso para ver el precio de producción.</p>
          <div className="form-actions">
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Cerrar
            </button>
          </div>
        </div>
      </div>
    );
  }

  function handleEnterEdit() {
    setDraft(precio?.precio === null || precio?.precio === undefined ? "" : String(precio.precio));
    setError(null);
    setMode("edit");
  }

  function handleCancelarEdicion() {
    setError(null);
    setMode("view");
  }

  const existingText = precio?.precio === null || precio?.precio === undefined ? "" : String(precio.precio);
  const dirty = draft.trim() !== existingText;

  async function handleGuardar() {
    if (!precio || !user || !token) return;
    setSaving(true);
    setError(null);

    const trimmed = draft.trim();
    let parsed: number | null = null;
    if (trimmed) {
      parsed = parseAmount(trimmed);
      if (parsed === null || parsed < 0) {
        setError("El precio de producción debe ser un número válido mayor o igual a 0, o quedar en blanco.");
        setSaving(false);
        return;
      }
    }

    try {
      const actor = { id: user.id, token };
      const updated = await savePrecioProduccion(actor, product.id, parsed);
      setPrecio(updated);
      setMode("view");
      setToastMessage("Precio de producción actualizado.");
    } catch (err) {
      setError(`No se pudo guardar el cambio: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        <h2>Precio de Producción — {product.nombre}</h2>

        {precio === null ? (
          <p className="hint">Cargando…</p>
        ) : (
          <div className="import-review-table-wrap">
            <table className="import-review-table">
              <thead>
                <tr>
                  <th>Precio</th>
                  <th>Fecha de modificación</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    {mode === "edit" && canModificar ? (
                      <input
                        type="text"
                        inputMode="decimal"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        disabled={saving}
                        style={{ width: "6rem" }}
                      />
                    ) : precio.precio === null ? (
                      "—"
                    ) : (
                      formatMoney(precio.precio)
                    )}
                  </td>
                  <td>{formatFechaCorta(precio.actualizado_en)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {error && <p className="form-error">{error}</p>}

        <div className="form-actions">
          {canModificar && mode === "view" && (
            <button type="button" className="btn btn-primary" onClick={handleEnterEdit} disabled={!precio}>
              Editar
            </button>
          )}
          {canModificar && mode === "edit" && (
            <>
              <button type="button" className="btn btn-primary" disabled={saving || !dirty} onClick={handleGuardar}>
                {saving ? "Guardando…" : "Guardar cambios"}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleCancelarEdicion}
                disabled={saving}
              >
                Cancelar edición
              </button>
            </>
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
