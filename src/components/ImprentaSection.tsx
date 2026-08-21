import { useEffect, useState } from "react";
import { getPrintItems, savePrintItems, getProduct } from "../db";
import type { PrintItem, PrintItemCheck, PrintItemExtra, Product } from "../types";
import { PROCESOS_IMPRENTA } from "../types";
import AutoGrowInput from "./AutoGrowInput";
import Toast from "./Toast";
import OrderModal from "./OrderModal";

interface Props {
  productId: number;
  onBack: () => void;
}

const TIPOS_PAPEL = ["Bond", "Sulfatada", "Cartulina", "Couché", "Opalina", "Kraft"];

const CAMPOS_VISTA: { label: string; key: keyof PrintItem }[] = [
  { label: "Tamaño extendido", key: "tamano_extendido" },
  { label: "Tamaño final", key: "tamano_final" },
  { label: "Tintas", key: "tintas" },
  { label: "Tipos de papel", key: "tipo_papel" },
  { label: "Gramos o puntos", key: "gramos_puntos" },
  { label: "Pliego", key: "pliego" },
  { label: "Cortes o tamaño", key: "cortes_tamano" },
  { label: "Máquina", key: "maquina" },
  { label: "Formación", key: "formacion" },
  { label: "Número de pliegos", key: "numero_pliegos" },
];

function emptyItem(orden: number): PrintItem {
  return {
    nombre: "",
    tamano_extendido: "",
    tamano_final: "",
    tintas: "",
    tipo_papel: "",
    gramos_puntos: "",
    pliego: "",
    cortes_tamano: "",
    maquina: "",
    formacion: "",
    numero_pliegos: "",
    checks: PROCESOS_IMPRENTA.map((nombre, i) => ({ nombre, marcado: false, orden: i + 1 })),
    extras: [],
    acabados: "",
    notas: "",
    orden,
  };
}

export default function ImprentaSection({ productId, onBack }: Props) {
  const [product, setProduct] = useState<Product | null>(null);
  const [items, setItems] = useState<PrintItem[]>([]);
  const [savedItems, setSavedItems] = useState<PrintItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orderItems, setOrderItems] = useState<PrintItem[] | null>(null);

  useEffect(() => {
    Promise.all([getPrintItems(productId), getProduct(productId)]).then(([i, p]) => {
      setItems(i);
      setSavedItems(i);
      setProduct(p);
      setLoading(false);
    });
  }, [productId]);

  function updateItem<K extends keyof PrintItem>(index: number, key: K, value: PrintItem[K]) {
    setDirty(true);
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, [key]: value } : item)));
  }

  function addItem() {
    setDirty(true);
    setItems((prev) => [...prev, emptyItem(prev.length + 1)]);
  }

  function removeItem(index: number) {
    setDirty(true);
    setItems((prev) => prev.filter((_, i) => i !== index));
  }

  function toggleCheck(itemIndex: number, checkIndex: number, marcado: boolean) {
    setDirty(true);
    setItems((prev) =>
      prev.map((item, i) =>
        i === itemIndex
          ? {
              ...item,
              checks: item.checks.map((check, ci) =>
                ci === checkIndex ? { ...check, marcado } : check,
              ),
            }
          : item,
      ),
    );
  }

  function addExtra(itemIndex: number) {
    setDirty(true);
    setItems((prev) =>
      prev.map((item, i) =>
        i === itemIndex
          ? {
              ...item,
              extras: [
                ...item.extras,
                { etiqueta: "", valor: "", orden: item.extras.length + 1 },
              ],
            }
          : item,
      ),
    );
  }

  function updateExtra<K extends keyof PrintItemExtra>(
    itemIndex: number,
    extraIndex: number,
    key: K,
    value: PrintItemExtra[K],
  ) {
    setDirty(true);
    setItems((prev) =>
      prev.map((item, i) =>
        i === itemIndex
          ? {
              ...item,
              extras: item.extras.map((extra, ei) =>
                ei === extraIndex ? { ...extra, [key]: value } : extra,
              ),
            }
          : item,
      ),
    );
  }

  function removeExtra(itemIndex: number, extraIndex: number) {
    setDirty(true);
    setItems((prev) =>
      prev.map((item, i) =>
        i === itemIndex
          ? { ...item, extras: item.extras.filter((_, ei) => ei !== extraIndex) }
          : item,
      ),
    );
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await savePrintItems(productId, items);
      const refreshed = await getPrintItems(productId);
      setItems(refreshed);
      setSavedItems(refreshed);
      setDirty(false);
      setEditMode(false);
      setShowToast(true);
    } catch (err) {
      setError(`No se pudo guardar: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setItems(savedItems);
    setDirty(false);
    setError(null);
    setEditMode(false);
  }

  if (loading) {
    return (
      <div className="private-section">
        <button className="btn-link" onClick={onBack}>
          ← Volver a la ficha técnica
        </button>
        <p className="hint">Cargando…</p>
      </div>
    );
  }

  return (
    <div className="private-section">
      <button className="btn-link" onClick={onBack}>
        ← Volver a la ficha técnica
      </button>
      <h1>Imprenta</h1>
      <p className="hint">
        Instructivos u otros elementos que requieren impresión, con sus datos de producción.
      </p>

      <datalist id="tipos-papel">
        {TIPOS_PAPEL.map((tipo) => (
          <option key={tipo} value={tipo} />
        ))}
      </datalist>

      {!editMode && (
        <div className="form-actions" style={{ margin: "1.1rem 0" }}>
          <button className="btn btn-primary" onClick={() => setEditMode(true)}>
            Editar
          </button>
          {items.length > 0 && (
            <button className="btn btn-secondary" onClick={() => setOrderItems(items)}>
              Crear orden general
            </button>
          )}
        </div>
      )}

      <div className="print-items-list">
        {items.length === 0 && !editMode && (
          <p className="hint">No hay productos de impresión registrados.</p>
        )}

        {items.map((item, index) =>
          editMode ? (
            <div className="print-item-card" key={index}>
              <div className="print-item-card-header">
                <AutoGrowInput
                  className="print-item-name-input"
                  placeholder="Nombre (ej. Instructivo, Caja, Etiqueta)"
                  value={item.nombre}
                  onChange={(v) => updateItem(index, "nombre", v)}
                />
                <button type="button" className="btn-link" onClick={() => removeItem(index)}>
                  Quitar
                </button>
              </div>

              <div className="print-item-fields">
                <label>
                  Tamaño extendido
                  <AutoGrowInput
                    placeholder="ej. 70x100 cm"
                    value={item.tamano_extendido}
                    onChange={(v) => updateItem(index, "tamano_extendido", v)}
                  />
                </label>
                <label>
                  Tamaño final
                  <AutoGrowInput
                    placeholder="ej. A5"
                    value={item.tamano_final}
                    onChange={(v) => updateItem(index, "tamano_final", v)}
                  />
                </label>
                <label>
                  Tintas
                  <AutoGrowInput
                    placeholder="ej. 4x0"
                    value={item.tintas}
                    onChange={(v) => updateItem(index, "tintas", v)}
                  />
                </label>
                <label>
                  Tipos de papel
                  <input
                    type="text"
                    list="tipos-papel"
                    value={item.tipo_papel}
                    onChange={(e) => updateItem(index, "tipo_papel", e.target.value)}
                  />
                </label>
                <label>
                  Gramos o puntos
                  <AutoGrowInput
                    placeholder="ej. 150g / 12pt"
                    value={item.gramos_puntos}
                    onChange={(v) => updateItem(index, "gramos_puntos", v)}
                  />
                </label>
                <label>
                  Pliego
                  <AutoGrowInput
                    value={item.pliego}
                    onChange={(v) => updateItem(index, "pliego", v)}
                  />
                </label>
                <label>
                  Cortes o tamaño
                  <AutoGrowInput
                    value={item.cortes_tamano}
                    onChange={(v) => updateItem(index, "cortes_tamano", v)}
                  />
                </label>
                <label>
                  Máquina
                  <AutoGrowInput
                    value={item.maquina}
                    onChange={(v) => updateItem(index, "maquina", v)}
                  />
                </label>
                <label>
                  Formación
                  <AutoGrowInput
                    placeholder="ej. 4x2"
                    value={item.formacion}
                    onChange={(v) => updateItem(index, "formacion", v)}
                  />
                </label>
                <label>
                  Número de pliegos
                  <AutoGrowInput
                    value={item.numero_pliegos}
                    onChange={(v) => updateItem(index, "numero_pliegos", v)}
                  />
                </label>
              </div>

              <div className="print-item-checks">
                <span className="print-item-checks-label">Procesos</span>
                <div className="print-item-checks-grid">
                  {item.checks.map((check: PrintItemCheck, checkIndex) => (
                    <label className="checkbox-label" key={check.nombre}>
                      <input
                        type="checkbox"
                        checked={check.marcado}
                        onChange={(e) => toggleCheck(index, checkIndex, e.target.checked)}
                      />
                      {check.nombre}
                    </label>
                  ))}
                </div>
              </div>

              <div className="print-item-extras">
                {item.extras.map((extra, extraIndex) => (
                  <div className="spec-row" key={extraIndex}>
                    <AutoGrowInput
                      placeholder="Etiqueta (ej. Barniz)"
                      value={extra.etiqueta}
                      onChange={(v) => updateExtra(index, extraIndex, "etiqueta", v)}
                    />
                    <AutoGrowInput
                      placeholder="Valor"
                      value={extra.valor}
                      onChange={(v) => updateExtra(index, extraIndex, "valor", v)}
                    />
                    <button
                      type="button"
                      className="btn-link"
                      onClick={() => removeExtra(index, extraIndex)}
                    >
                      Quitar
                    </button>
                  </div>
                ))}
                <button type="button" className="btn-link" onClick={() => addExtra(index)}>
                  + Agregar otro segmento
                </button>
              </div>

              <label className="print-item-notas">
                Acabados
                <AutoGrowInput
                  multiline
                  value={item.acabados}
                  onChange={(v) => updateItem(index, "acabados", v)}
                />
              </label>

              <label className="print-item-notas">
                Notas
                <AutoGrowInput
                  multiline
                  value={item.notas}
                  onChange={(v) => updateItem(index, "notas", v)}
                />
              </label>
            </div>
          ) : (
            <div className="print-item-card" key={index}>
              <div className="print-item-card-header">
                <h3>{item.nombre || "(sin nombre)"}</h3>
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => setOrderItems([item])}
                >
                  Crear orden
                </button>
              </div>

              <div className="print-item-view-fields">
                {CAMPOS_VISTA.map((campo) => (
                  <div className="print-item-view-field" key={campo.key}>
                    <span className="print-item-view-field-label">{campo.label}</span>
                    <span className="print-item-view-field-value">
                      {(item[campo.key] as string) || "—"}
                    </span>
                  </div>
                ))}
              </div>

              <div className="print-item-view-section">
                <span className="print-item-view-field-label">Procesos</span>
                <span className="print-item-view-field-value">
                  {item.checks.filter((c) => c.marcado).map((c) => c.nombre).join(", ") ||
                    "Ninguno"}
                </span>
              </div>

              {item.extras.length > 0 && (
                <div className="print-item-view-section">
                  <span className="print-item-view-field-label">Otros segmentos</span>
                  {item.extras.map((extra, i) => (
                    <span className="print-item-view-field-value" key={i}>
                      {extra.etiqueta || "(sin etiqueta)"}: {extra.valor || "—"}
                    </span>
                  ))}
                </div>
              )}

              {item.acabados && (
                <div className="print-item-view-section">
                  <span className="print-item-view-field-label">Acabados</span>
                  <span
                    className="print-item-view-field-value"
                    style={{ whiteSpace: "pre-wrap" }}
                  >
                    {item.acabados}
                  </span>
                </div>
              )}

              {item.notas && (
                <div className="print-item-view-section">
                  <span className="print-item-view-field-label">Notas</span>
                  <span
                    className="print-item-view-field-value"
                    style={{ whiteSpace: "pre-wrap" }}
                  >
                    {item.notas}
                  </span>
                </div>
              )}
            </div>
          ),
        )}
      </div>

      {editMode && (
        <button type="button" className="btn-link" onClick={addItem}>
          + Agregar producto de impresión
        </button>
      )}

      {error && <p className="form-error">{error}</p>}

      {editMode && (
        <div className="form-actions">
          <button className="btn btn-primary" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? "Guardando…" : "Guardar"}
          </button>
          <button className="btn btn-secondary" onClick={handleCancel} disabled={saving}>
            Cancelar
          </button>
        </div>
      )}

      <Toast message="Guardado con éxito" show={showToast} onHide={() => setShowToast(false)} />

      {orderItems && product && (
        <OrderModal product={product} items={orderItems} onClose={() => setOrderItems(null)} />
      )}
    </div>
  );
}
