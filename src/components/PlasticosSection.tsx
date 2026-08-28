import { useEffect, useState } from "react";
import {
  getImageSrc,
  getPlasticItems,
  logEvent,
  pickImage,
  savePlasticItems,
} from "../db";
import type { PlasticItem, PlasticProduct, PlasticProductInput } from "../types";
import { hasPermission, useAuth } from "../auth";
import AutoGrowInput from "./AutoGrowInput";
import Toast from "./Toast";
import PlasticProductPicker from "./PlasticProductPicker";
import basuraIcon from "../../Assets/basura.svg";

interface Props {
  productId: number;
  onBack: () => void;
}

const ORIGENES = ["BOD", "GIL", "IMPR", "EXTR"] as const;

const EMPTY_DATA: PlasticProductInput = {
  nombre: "",
  sku: "",
  color: "",
  origen: "",
  descripcion: "",
  armado: "",
  dimension: "",
  peso: "",
  tipo_empaque: "",
  imagen: null,
  imagen_codigo_barras: null,
};

const CAMPOS_VISTA: { label: string; key: keyof PlasticProductInput }[] = [
  { label: "SKU", key: "sku" },
  { label: "Color", key: "color" },
  { label: "Origen", key: "origen" },
  { label: "Armado", key: "armado" },
  { label: "Dimensión", key: "dimension" },
  { label: "Peso", key: "peso" },
  { label: "Tipo de empaque", key: "tipo_empaque" },
];

export default function PlasticosSection({ productId, onBack }: Props) {
  const { user } = useAuth();
  const allowed = hasPermission(user, "plasticos");
  const [items, setItems] = useState<PlasticItem[]>([]);
  const [savedItems, setSavedItems] = useState<PlasticItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!allowed) return;
    getPlasticItems(productId).then((list) => {
      setItems(list);
      setSavedItems(list);
      setLoading(false);
    });
  }, [productId, allowed]);

  useEffect(() => {
    if (allowed) return;
    logEvent(
      "WARNING",
      `Acceso denegado a Piezas para ${user?.username ?? "desconocido"}`,
      user?.username ?? null,
    );
  }, [allowed, user?.username]);

  function updateItemData(index: number, patch: Partial<PlasticProductInput>) {
    setDirty(true);
    setItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, data: { ...item.data, ...patch } } : item)),
    );
  }

  function addNewItem() {
    setDirty(true);
    setItems((prev) => [
      ...prev,
      { plastic_product_id: null, orden: prev.length + 1, data: { ...EMPTY_DATA } },
    ]);
  }

  function addExistingProduct(producto: PlasticProduct) {
    setDirty(true);
    setItems((prev) => [
      ...prev,
      {
        plastic_product_id: producto.id,
        orden: prev.length + 1,
        data: {
          nombre: producto.nombre,
          sku: producto.sku,
          color: producto.color,
          origen: producto.origen,
          descripcion: producto.descripcion,
          armado: producto.armado,
          dimension: producto.dimension,
          peso: producto.peso,
          tipo_empaque: producto.tipo_empaque,
          imagen: producto.imagen,
          imagen_codigo_barras: producto.imagen_codigo_barras,
        },
      },
    ]);
    setShowPicker(false);
  }

  function removeItem(index: number) {
    setDirty(true);
    setItems((prev) => prev.filter((_, i) => i !== index));
  }

  async function pickProductImage(index: number) {
    const image = await pickImage();
    if (!image) return;
    updateItemData(index, { imagen: image });
  }

  async function pickBarcodeImage(index: number) {
    const image = await pickImage();
    if (!image) return;
    updateItemData(index, { imagen_codigo_barras: image });
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await savePlasticItems(productId, items);
      const refreshed = await getPlasticItems(productId);
      setItems(refreshed);
      setSavedItems(refreshed);
      setDirty(false);
      setEditMode(false);
      setShowToast(true);
    } catch (err) {
      setError(`No se pudo guardar: ${String(err)}`);
      logEvent("ERROR", `No se pudo guardar Piezas del producto ${productId}: ${String(err)}`, user?.username ?? null);
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

  if (!allowed) {
    return (
      <div className="private-section">
        <button className="btn-link" onClick={onBack}>
          ← Volver a la ficha técnica
        </button>
        <h1>Acceso denegado</h1>
        <p className="hint">No tienes permiso para ver esta sección.</p>
      </div>
    );
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

  const linkedIds = items
    .map((item) => item.plastic_product_id)
    .filter((id): id is number => id !== null);

  return (
    <div className="private-section">
      <button className="btn-link" onClick={onBack}>
        ← Volver a la ficha técnica
      </button>
      <h1>Piezas</h1>
      <p className="hint">
        Piezas usadas en este juego. Cada una vive en el catálogo de Piezas y puede reutilizarse
        en otros juegos sin volver a capturarla.
      </p>

      {!editMode && (
        <div className="form-actions" style={{ margin: "1.1rem 0" }}>
          <button className="btn btn-primary" onClick={() => setEditMode(true)}>
            Editar
          </button>
        </div>
      )}

      <div className="plastic-items-list">
        {items.length === 0 && !editMode && (
          <p className="hint">No hay piezas registradas.</p>
        )}

        {items.map((item, index) => (
          <PlasticItemCard
            key={item.id ?? `new-${index}`}
            item={item}
            editMode={editMode}
            onChange={(patch) => updateItemData(index, patch)}
            onPickImage={() => pickProductImage(index)}
            onPickBarcode={() => pickBarcodeImage(index)}
            onRemove={() => removeItem(index)}
          />
        ))}
      </div>

      {editMode && (
        <div className="plastic-items-add-actions">
          <button type="button" className="btn-link" onClick={addNewItem}>
            + Agregar producto nuevo
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setShowPicker(true)}>
            Agregar un producto existente
          </button>
        </div>
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

      {showPicker && (
        <PlasticProductPicker
          excludeIds={linkedIds}
          onSelect={addExistingProduct}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}

interface PlasticItemCardProps {
  item: PlasticItem;
  editMode: boolean;
  onChange: (patch: Partial<PlasticProductInput>) => void;
  onPickImage: () => void;
  onPickBarcode: () => void;
  onRemove: () => void;
}

function PlasticItemCard({
  item,
  editMode,
  onChange,
  onPickImage,
  onPickBarcode,
  onRemove,
}: PlasticItemCardProps) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [barcodeSrc, setBarcodeSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getImageSrc(item.data.imagen).then((src) => {
      if (!cancelled) setImageSrc(src);
    });
    return () => {
      cancelled = true;
    };
  }, [item.data.imagen]);

  useEffect(() => {
    let cancelled = false;
    getImageSrc(item.data.imagen_codigo_barras).then((src) => {
      if (!cancelled) setBarcodeSrc(src);
    });
    return () => {
      cancelled = true;
    };
  }, [item.data.imagen_codigo_barras]);

  return (
    <div className="plastic-item-card">
      <div className="plastic-item-card-header">
        {editMode ? (
          <AutoGrowInput
            className="print-item-name-input"
            placeholder="Nombre"
            value={item.data.nombre}
            onChange={(v) => onChange({ nombre: v })}
          />
        ) : (
          <h3>{item.data.nombre || "(sin nombre)"}</h3>
        )}
        {editMode && (
          <button
            type="button"
            className="icon-btn icon-btn-remove"
            onClick={onRemove}
            title="Quitar de este juego"
            aria-label="Quitar de este juego"
          >
            <img src={basuraIcon} alt="" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="plastic-item-layout">
        <div className="plastic-item-media-col">
          <div className="plastic-item-image-box">
            {imageSrc ? (
              <img src={imageSrc} alt={item.data.nombre || "Producto"} />
            ) : (
              <span className="product-card-placeholder">Sin imagen</span>
            )}
            {editMode && (
              <button type="button" className="btn btn-secondary" onClick={onPickImage}>
                {imageSrc ? "Cambiar imagen" : "Agregar imagen"}
              </button>
            )}
          </div>
          <div className="plastic-item-barcode-box">
            {barcodeSrc ? (
              <img src={barcodeSrc} alt="Código de barras" />
            ) : (
              <span className="product-card-placeholder">Sin código de barras</span>
            )}
            {editMode && (
              <button type="button" className="btn btn-secondary" onClick={onPickBarcode}>
                {barcodeSrc ? "Cambiar código de barras" : "Agregar código de barras"}
              </button>
            )}
          </div>
        </div>

        {editMode ? (
          <div className="plastic-item-fields">
            <PlasticField label="SKU" value={item.data.sku} onChange={(v) => onChange({ sku: v })} />
            <PlasticField label="Color" value={item.data.color} onChange={(v) => onChange({ color: v })} />
            <label className="plastic-item-field">
              <span>Origen</span>
              <select value={item.data.origen} onChange={(e) => onChange({ origen: e.target.value })}>
                <option value="">Sin definir</option>
                {ORIGENES.map((origen) => (
                  <option key={origen} value={origen}>
                    {origen}
                  </option>
                ))}
              </select>
            </label>
            <PlasticField label="Armado" value={item.data.armado} onChange={(v) => onChange({ armado: v })} />
            <PlasticField
              label="Dimensión"
              value={item.data.dimension}
              onChange={(v) => onChange({ dimension: v })}
            />
            <PlasticField label="Peso" value={item.data.peso} onChange={(v) => onChange({ peso: v })} />
            <PlasticField
              label="Tipo de empaque"
              value={item.data.tipo_empaque}
              onChange={(v) => onChange({ tipo_empaque: v })}
            />
          </div>
        ) : (
          <div className="plastic-item-view-fields">
            {CAMPOS_VISTA.map((campo) => (
              <div className="plastic-item-view-field" key={campo.key}>
                <span className="plastic-item-view-field-label">{campo.label}</span>
                <span className="plastic-item-view-field-value">
                  {(item.data[campo.key] as string) || "—"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface PlasticFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

function PlasticField({ label, value, onChange }: PlasticFieldProps) {
  return (
    <label className="plastic-item-field">
      <span>{label}</span>
      <AutoGrowInput value={value} onChange={onChange} />
    </label>
  );
}
