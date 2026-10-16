import { useState } from "react";
import { updateProductBodega } from "../db";
import type { ProductBodegaInput } from "../db";
import { TIPOS_PRODUCTO } from "../types";
import type { Product } from "../types";
import { useAuth } from "../auth";
import AutoGrowInput from "./AutoGrowInput";
import Toast from "./Toast";

interface Props {
  product: Product;
  onClose: () => void;
  onSaved: () => void;
}

function toDraft(product: Product): ProductBodegaInput {
  return {
    tipo_producto: product.tipo_producto,
    dimensiones_empaque: product.dimensiones_empaque,
    juegos_por_empaque: product.juegos_por_empaque,
    peso_empaque: product.peso_empaque,
    volumen_empaque: product.volumen_empaque,
  };
}

export default function BodegaModal({ product, onClose, onSaved }: Props) {
  const { user, token } = useAuth();
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [draft, setDraft] = useState<ProductBodegaInput>(() => toDraft(product));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const original = toDraft(product);
  const dirty = (Object.keys(original) as (keyof ProductBodegaInput)[]).some(
    (key) => draft[key].trim() !== original[key].trim(),
  );

  function update(patch: Partial<ProductBodegaInput>) {
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  function handleEnterEdit() {
    setDraft(toDraft(product));
    setError(null);
    setMode("edit");
  }

  function handleCancelarEdicion() {
    setError(null);
    setMode("view");
  }

  async function handleGuardar() {
    if (!user || !token) return;
    setSaving(true);
    setError(null);
    try {
      await updateProductBodega({ id: user.id, token }, product.id, draft);
      setMode("view");
      setToastMessage("Datos de bodega actualizados.");
      onSaved();
    } catch (err) {
      setError(`No se pudo guardar el cambio: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  const editing = mode === "edit";

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        <h2>Bodega — {product.nombre}</h2>

        <div className="import-review-table-wrap">
          <table className="import-review-table">
            <tbody>
              <tr>
                <th>Tipo de producto</th>
                <td>
                  {editing ? (
                    <select
                      value={draft.tipo_producto}
                      onChange={(e) => update({ tipo_producto: e.target.value })}
                      disabled={saving}
                    >
                      <option value="">Sin asignar</option>
                      {TIPOS_PRODUCTO.map((tipo) => (
                        <option key={tipo} value={tipo}>
                          {tipo}
                        </option>
                      ))}
                    </select>
                  ) : (
                    product.tipo_producto || "Sin asignar"
                  )}
                </td>
              </tr>
              <tr>
                <th>Dimensiones de empaque</th>
                <td>
                  {editing ? (
                    <AutoGrowInput
                      value={draft.dimensiones_empaque}
                      onChange={(v) => update({ dimensiones_empaque: v })}
                      placeholder="ej. 28 x 28 cm"
                    />
                  ) : (
                    product.dimensiones_empaque || "—"
                  )}
                </td>
              </tr>
              <tr>
                <th>Juegos por empaque</th>
                <td>
                  {editing ? (
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={draft.juegos_por_empaque}
                      onChange={(e) => update({ juegos_por_empaque: e.target.value })}
                      disabled={saving}
                    />
                  ) : (
                    product.juegos_por_empaque || "—"
                  )}
                </td>
              </tr>
              <tr>
                <th>Peso empaque (Kg)</th>
                <td>
                  {editing ? (
                    <AutoGrowInput value={draft.peso_empaque} onChange={(v) => update({ peso_empaque: v })} />
                  ) : (
                    product.peso_empaque || "—"
                  )}
                </td>
              </tr>
              <tr>
                <th>Volumen empaque (M3)</th>
                <td>
                  {editing ? (
                    <AutoGrowInput
                      value={draft.volumen_empaque}
                      onChange={(v) => update({ volumen_empaque: v })}
                    />
                  ) : (
                    product.volumen_empaque || "—"
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {error && <p className="form-error">{error}</p>}

        <div className="form-actions">
          {!editing && (
            <button type="button" className="btn btn-primary" onClick={handleEnterEdit}>
              Editar
            </button>
          )}
          {editing && (
            <>
              <button type="button" className="btn btn-primary" disabled={saving || !dirty} onClick={handleGuardar}>
                {saving ? "Guardando…" : "Guardar cambios"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={handleCancelarEdicion} disabled={saving}>
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
