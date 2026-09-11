import { useEffect, useState } from "react";
import { getPreciosVenta, savePreciosVenta } from "../db";
import { parseAmount } from "../precios";
import { formatMoney } from "../excelExport";
import type { PrecioVenta, PrecioVentaEntradaInput, Product } from "../types";
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

export default function PreciosVentaModal({ product, onClose }: Props) {
  const { user, token } = useAuth();
  const canVer = hasPermission(user, "precios_venta_ver");
  const canModificar = hasPermission(user, "precios_venta_modificar");

  const [precios, setPrecios] = useState<PrecioVenta[] | null>(null);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!canVer || !user || !token) return;
    const actor = { id: user.id, token };
    let cancelled = false;
    (async () => {
      const list = await getPreciosVenta(actor, product.id);
      if (!cancelled) setPrecios(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [canVer, product.id, user, token]);

  if (!canVer) {
    return (
      <div className="modal-overlay" role="dialog" aria-modal="true">
        <div className="modal-card">
          <h2>Precios Venta</h2>
          <p className="hint">No tienes permiso para ver precios de venta.</p>
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
    setDrafts(new Map());
    setError(null);
    setMode("edit");
  }

  function handleCancelarEdicion() {
    setDrafts(new Map());
    setError(null);
    setMode("view");
  }

  function setDraft(categoria: string, value: string) {
    setDrafts((prev) => {
      const next = new Map(prev);
      next.set(categoria, value);
      return next;
    });
  }

  const dirty = [...drafts.entries()].some(([categoria, value]) => {
    const existing = precios?.find((p) => p.categoria === categoria);
    const existingText = existing?.precio === null || existing?.precio === undefined ? "" : String(existing.precio);
    return value.trim() !== existingText;
  });

  async function handleGuardar() {
    if (!precios || !user || !token) return;
    setSaving(true);
    setError(null);

    // Validar todo antes de escribir nada, mismo criterio que PreciosModal.
    const entradas: PrecioVentaEntradaInput[] = [];
    for (const p of precios) {
      const draft = drafts.get(p.categoria);
      if (draft === undefined) {
        entradas.push({ categoria: p.categoria, precio: p.precio });
        continue;
      }
      const trimmed = draft.trim();
      if (!trimmed) {
        entradas.push({ categoria: p.categoria, precio: null });
        continue;
      }
      const parsed = parseAmount(trimmed);
      if (parsed === null || parsed < 0) {
        setError(`El precio de "${p.categoria}" debe ser un número válido mayor o igual a 0, o quedar en blanco.`);
        setSaving(false);
        return;
      }
      entradas.push({ categoria: p.categoria, precio: parsed });
    }

    try {
      const actor = { id: user.id, token };
      const updated = await savePreciosVenta(actor, product.id, entradas);
      setPrecios(updated);
      setDrafts(new Map());
      setMode("view");
      setToastMessage("Precios de venta actualizados.");
    } catch (err) {
      setError(`No se pudieron guardar los cambios: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        <h2>Precios Venta — {product.nombre}</h2>

        {precios === null ? (
          <p className="hint">Cargando…</p>
        ) : (
          <div className="import-review-table-wrap">
            <table className="import-review-table">
              <thead>
                <tr>
                  <th>Categoría</th>
                  <th>Precio</th>
                  <th>Fecha de modificación</th>
                </tr>
              </thead>
              <tbody>
                {precios.map((p) => (
                  <tr key={p.categoria}>
                    <td>{p.categoria}</td>
                    <td>
                      {mode === "edit" && canModificar ? (
                        <input
                          type="text"
                          inputMode="decimal"
                          value={drafts.get(p.categoria) ?? (p.precio === null ? "" : String(p.precio))}
                          onChange={(e) => setDraft(p.categoria, e.target.value)}
                          disabled={saving}
                          style={{ width: "6rem" }}
                        />
                      ) : p.precio === null ? (
                        "—"
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
          {canModificar && mode === "view" && (
            <button type="button" className="btn btn-primary" onClick={handleEnterEdit} disabled={!precios}>
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
