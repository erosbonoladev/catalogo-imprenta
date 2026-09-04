import { useEffect, useState } from "react";
import { getPrecio, getPreciosBySkuPrincipal, updatePrecio, upsertPrecio } from "../db";
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
  const { user, token } = useAuth();
  const canVer = hasPermission(user, "precios_ver");
  const canModificar = hasPermission(user, "precios_modificar");

  const [precios, setPrecios] = useState<Precio[] | null>(null);
  const [drafts, setDrafts] = useState<Map<number, { sku?: string; precio?: string }>>(new Map());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const [addingNew, setAddingNew] = useState(false);
  const [newSku, setNewSku] = useState("");
  const [newNombre, setNewNombre] = useState("");
  const [newPrecio, setNewPrecio] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [addSaving, setAddSaving] = useState(false);
  const [duplicatePrecio, setDuplicatePrecio] = useState<Precio | null>(null);

  async function refreshPrecios() {
    const skuPrincipal = computeSkuPrincipal(product.codigo);
    const list = await getPreciosBySkuPrincipal(skuPrincipal);
    setPrecios(list);
  }

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

  function setDraftField(id: number, field: "sku" | "precio", value: string) {
    setDrafts((prev) => {
      const next = new Map(prev);
      next.set(id, { ...next.get(id), [field]: value });
      return next;
    });
  }

  const dirtyIds = [...drafts.keys()].filter((id) => {
    const precio = precios?.find((p) => p.id === id);
    const draft = drafts.get(id);
    if (!precio || !draft) return false;
    const skuChanged = draft.sku !== undefined && draft.sku.trim() !== precio.sku;
    if (skuChanged) return true;
    if (draft.precio === undefined) return false;
    // Comparar como número, no como texto: retipear "10.50" sobre un precio
    // guardado como 10.5 no debe contar como cambio real (evita un renglón
    // de precios_historial con precio_anterior === precio_nuevo).
    const draftPrecio = Number(draft.precio);
    return !Number.isFinite(draftPrecio) || draftPrecio !== precio.precio;
  });

  async function handleGuardar() {
    if (!precios || dirtyIds.length === 0) return;
    if (!user || !token) return;
    const actor = { id: user.id, token };
    setSaving(true);
    setError(null);

    // Validar todo antes de escribir nada — si una fila tiene un dato
    // inválido no queremos haber guardado ya la mitad de las otras filas.
    const toSave: { id: number; sku: string; nombre: string; precio: number }[] = [];
    for (const id of dirtyIds) {
      const existing = precios.find((p) => p.id === id);
      if (!existing) continue;
      const draft = drafts.get(id) ?? {};

      const sku = (draft.sku ?? existing.sku).trim();
      if (!sku) {
        setError(`El SKU de "${existing.nombre}" no puede quedar vacío.`);
        setSaving(false);
        return;
      }

      const nuevoPrecio = draft.precio !== undefined ? Number(draft.precio) : existing.precio;
      if (!Number.isFinite(nuevoPrecio) || nuevoPrecio <= 0) {
        setError(`El precio de ${sku} debe ser un número mayor que 0.`);
        setSaving(false);
        return;
      }
      toSave.push({ id, sku, nombre: existing.nombre, precio: nuevoPrecio });
    }

    try {
      // Secuencial, no en paralelo: un cambio de SKU se valida contra el
      // estado actual de la tabla, así que dos renglones no deben escribirse
      // a la vez (evita colisiones si uno pide el SKU que otro está dejando).
      for (const item of toSave) {
        await updatePrecio(actor, item.id, {
          sku: item.sku,
          nombre: item.nombre,
          precio: item.precio,
          usuario: user?.username ?? null,
        });
      }
      const skuPrincipal = computeSkuPrincipal(product.codigo);
      const refreshed = await getPreciosBySkuPrincipal(skuPrincipal);
      setPrecios(refreshed);
      setDrafts(new Map());
      setToastMessage("Precios actualizados.");
    } catch (err) {
      setError(`No se pudieron guardar los cambios: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  function resetNewForm() {
    setAddingNew(false);
    setNewSku("");
    setNewNombre("");
    setNewPrecio("");
    setAddError(null);
    setDuplicatePrecio(null);
  }

  function validateNewForm(): { sku: string; nombre: string; precio: number } | null {
    const sku = newSku.trim();
    const nombre = newNombre.trim();
    if (!sku) {
      setAddError("El SKU es obligatorio.");
      return null;
    }
    if (!nombre) {
      setAddError("El nombre es obligatorio.");
      return null;
    }
    const precio = Number(newPrecio.replace(",", "."));
    if (!Number.isFinite(precio) || precio < 0) {
      setAddError("El precio debe ser un número mayor o igual a 0.");
      return null;
    }
    return { sku, nombre, precio };
  }

  // Chequea el SKU exacto (no el sku_principal) — variantes con letra
  // (7078E) son productos relacionados válidos bajo el mismo grupo, no
  // duplicados del SKU base.
  async function handleSubmitNew() {
    setAddError(null);
    const parsed = validateNewForm();
    if (!parsed || !user || !token) return;
    const actor = { id: user.id, token };
    setAddSaving(true);
    try {
      const existing = await getPrecio(parsed.sku);
      if (existing) {
        setDuplicatePrecio(existing);
        return;
      }
      await upsertPrecio(actor, { ...parsed, usuario: user?.username ?? null });
      await refreshPrecios();
      resetNewForm();
      setToastMessage("Producto agregado.");
    } catch (err) {
      setAddError(`No se pudo guardar el producto: ${String(err)}`);
    } finally {
      setAddSaving(false);
    }
  }

  async function handleConfirmarActualizarExistente() {
    const parsed = validateNewForm();
    if (!parsed || !duplicatePrecio || !user || !token) return;
    const actor = { id: user.id, token };
    setAddSaving(true);
    try {
      await upsertPrecio(actor, { ...parsed, usuario: user?.username ?? null });
      await refreshPrecios();
      resetNewForm();
      setToastMessage("Producto actualizado.");
    } catch (err) {
      setAddError(`No se pudo actualizar el producto: ${String(err)}`);
    } finally {
      setAddSaving(false);
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
                  <tr key={p.id}>
                    <td>
                      {canModificar ? (
                        <input
                          type="text"
                          value={drafts.get(p.id)?.sku ?? p.sku}
                          onChange={(e) => setDraftField(p.id, "sku", e.target.value)}
                          disabled={saving}
                          style={{ width: "6rem" }}
                        />
                      ) : (
                        p.sku
                      )}
                    </td>
                    <td>{p.nombre}</td>
                    <td>
                      {canModificar ? (
                        <input
                          type="text"
                          inputMode="decimal"
                          value={drafts.get(p.id)?.precio ?? String(p.precio)}
                          onChange={(e) => setDraftField(p.id, "precio", e.target.value)}
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

        {canModificar && (
          <>
            {!addingNew ? (
              <button type="button" className="btn-link" onClick={() => setAddingNew(true)}>
                Agregar nuevo producto
              </button>
            ) : (
              <div className="remision-manual-entry">
                <div className="form-row">
                  <label>
                    SKU
                    <input
                      type="text"
                      value={newSku}
                      onChange={(e) => setNewSku(e.target.value)}
                      disabled={addSaving}
                      autoFocus
                    />
                  </label>
                  <label>
                    Nombre del producto
                    <input
                      type="text"
                      value={newNombre}
                      onChange={(e) => setNewNombre(e.target.value)}
                      disabled={addSaving}
                    />
                  </label>
                  <label>
                    Precio
                    <input
                      type="text"
                      inputMode="decimal"
                      value={newPrecio}
                      onChange={(e) => setNewPrecio(e.target.value)}
                      disabled={addSaving}
                      style={{ width: "6rem" }}
                    />
                  </label>
                </div>
                <p className="hint" style={{ margin: 0 }}>
                  La fecha de modificación se asigna automáticamente al guardar.
                </p>

                {duplicatePrecio ? (
                  <span className="confirm-delete">
                    El SKU {duplicatePrecio.sku} ya existe ({duplicatePrecio.nombre} —{" "}
                    {formatMoney(duplicatePrecio.precio)}). ¿Actualizarlo con estos datos?
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={handleConfirmarActualizarExistente}
                      disabled={addSaving}
                    >
                      Actualizar
                    </button>
                    <button type="button" className="btn-link" onClick={resetNewForm} disabled={addSaving}>
                      Cancelar
                    </button>
                  </span>
                ) : (
                  <>
                    {addError && <p className="form-error">{addError}</p>}
                    <div className="form-actions">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={handleSubmitNew}
                        disabled={addSaving}
                      >
                        {addSaving ? "Guardando…" : "Guardar producto"}
                      </button>
                      <button type="button" className="btn btn-secondary" onClick={resetNewForm} disabled={addSaving}>
                        Cancelar
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}

        <div className="form-actions">
          {canModificar && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving || dirtyIds.length === 0}
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
