import { useEffect, useState } from "react";
import { getImageSrc, getPlasticItems, getWoodItems, logEventAsActor, pickImage, saveWoodItems } from "../db";
import type { PlasticItem, WoodItem, WoodProduct, WoodProductInput } from "../types";
import { hasPermission, useAuth } from "../auth";
import { useRevokeObjectUrl } from "../hooks/useRevokeObjectUrl";
import AutoGrowInput from "./AutoGrowInput";
import Toast from "./Toast";
import WoodProductPicker from "./WoodProductPicker";
import WoodProductFields, { EMPTY_WOOD_DATA, formatWoodMoney } from "./WoodProductFields";
import basuraIcon from "../../Assets/basura.svg";

interface Props {
  productId: number;
  onBack: () => void;
  onOpenPiezas: () => void;
}

type CampoVista = { label: string; key: keyof WoodProductInput; tipo: "texto" | "dinero" };

const CAMPOS_VISTA: CampoVista[] = [
  { label: "SKU", key: "sku", tipo: "texto" },
  { label: "Tamaño", key: "tamano", tipo: "texto" },
  { label: "Capas", key: "capas", tipo: "texto" },
  { label: "Largo", key: "largo", tipo: "texto" },
  { label: "Ancho", key: "ancho", tipo: "texto" },
  { label: "Espesor de la madera", key: "espesor", tipo: "texto" },
  { label: "Caben en una hoja de MDF 122 x 244", key: "caben_hoja_mdf", tipo: "texto" },
  { label: "Minutos en láser", key: "minutos_laser", tipo: "texto" },
  { label: "Importe madera", key: "importe_madera", tipo: "dinero" },
  { label: "Pintura", key: "pintura", tipo: "dinero" },
  { label: "Importe corte láser", key: "importe_corte_laser", tipo: "dinero" },
  { label: "Etiqueta adhesiva", key: "etiqueta_adhesiva", tipo: "dinero" },
  { label: "Otro", key: "otro_importe", tipo: "dinero" },
  { label: "Concepto de Otro", key: "otro_concepto", tipo: "texto" },
  { label: "Etiqueta empaque", key: "etiqueta_empaque", tipo: "dinero" },
  { label: "Costo total", key: "costo_total", tipo: "dinero" },
  { label: "Precio venta", key: "precio_venta", tipo: "dinero" },
];

// Piezas ya registradas en el catálogo de Piezas cuyo nombre o material
// sugiere que son madera/MDF (ej. piezas capturadas ahí antes de que
// existiera esta sección) — no se migran ni se duplican, solo se muestran
// aquí también, de solo lectura, con un link de vuelta a Piezas. Ver
// docs/DATABASE.md.
const MADERA_LIKE_RE = /madera|mdf/i;

function isMaderaLike(item: PlasticItem): boolean {
  return MADERA_LIKE_RE.test(item.data.nombre) || MADERA_LIKE_RE.test(item.data.material);
}

function sameNombreSku(a: { nombre: string; sku: string }, b: { nombre: string; sku: string }): boolean {
  return (
    a.nombre.trim().toLowerCase() === b.nombre.trim().toLowerCase() &&
    a.sku.trim().toLowerCase() === b.sku.trim().toLowerCase()
  );
}

export default function MaderasSection({ productId, onBack, onOpenPiezas }: Props) {
  const { user, token } = useAuth();
  const allowed = hasPermission(user, "maderas");
  const [items, setItems] = useState<WoodItem[]>([]);
  const [savedItems, setSavedItems] = useState<WoodItem[]>([]);
  const [piezasMaderaLike, setPiezasMaderaLike] = useState<PlasticItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  function loadItems() {
    setLoading(true);
    setLoadError(null);
    Promise.all([getWoodItems(productId), getPlasticItems(productId)])
      .then(([wood, piezas]) => {
        setItems(wood);
        setSavedItems(wood);
        setPiezasMaderaLike(piezas.filter(isMaderaLike));
      })
      .catch((err) => setLoadError(`No se pudieron cargar las maderas: ${String(err)}`))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (!allowed) return;
    loadItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, allowed]);

  useEffect(() => {
    if (allowed || !user || !token) return;
    logEventAsActor({ id: user.id, token }, "WARNING", `Acceso denegado a Maderas para ${user.username}`);
  }, [allowed, user, token]);

  function updateItemData(index: number, patch: Partial<WoodProductInput>) {
    setDirty(true);
    setItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, data: { ...item.data, ...patch } } : item)),
    );
  }

  async function pickProductImage(index: number) {
    const image = await pickImage();
    if (!image) return;
    updateItemData(index, { imagen: image });
  }

  function addNewItem() {
    setDirty(true);
    setItems((prev) => [
      ...prev,
      { wood_product_id: null, orden: prev.length + 1, data: { ...EMPTY_WOOD_DATA } },
    ]);
  }

  function addExistingProduct(producto: WoodProduct) {
    setDirty(true);
    setItems((prev) => [
      ...prev,
      {
        wood_product_id: producto.id,
        orden: prev.length + 1,
        data: {
          nombre: producto.nombre,
          sku: producto.sku,
          tamano: producto.tamano,
          capas: producto.capas,
          largo: producto.largo,
          ancho: producto.ancho,
          espesor: producto.espesor,
          caben_hoja_mdf: producto.caben_hoja_mdf,
          minutos_laser: producto.minutos_laser,
          importe_madera: producto.importe_madera,
          pintura: producto.pintura,
          importe_corte_laser: producto.importe_corte_laser,
          etiqueta_adhesiva: producto.etiqueta_adhesiva,
          otro_importe: producto.otro_importe,
          otro_concepto: producto.otro_concepto,
          etiqueta_empaque: producto.etiqueta_empaque,
          costo_total: producto.costo_total,
          precio_venta: producto.precio_venta,
          imagen: producto.imagen,
        },
      },
    ]);
    setShowPicker(false);
  }

  // "Agregar datos de madera" sobre una pieza de Piezas ya vinculada a esta
  // ficha (subsección de solo lectura más abajo): crea un producto de
  // Maderas nuevo, precargado con nombre/SKU/imagen de esa pieza (si ya
  // tenía foto en Piezas, se reutiliza en vez de partir sin imagen — el
  // usuario puede cambiarla después igual que cualquier otro producto de
  // Maderas), listo para completar con Capas/Largo/Ancho/importes — la
  // pieza original en Piezas no se toca ni se duplica su información, son
  // registros independientes con propósitos distintos (decidido con el
  // usuario, ver docs/PERMISSIONS.md).
  //
  // Idempotente a propósito: si ya se agregó un producto de Maderas desde
  // esta misma pieza (mismo nombre+SKU) no se crea otro — sin esto, el
  // botón seguía visible después de "promover" una pieza (no hay forma de
  // saber desde el catálogo de Piezas que ya se hizo), y un segundo clic
  // duplicaba el producto en la próxima vez que se guardaba.
  function addFromPieza(pieza: PlasticItem) {
    if (items.some((item) => sameNombreSku(item.data, pieza.data))) return;
    setDirty(true);
    setEditMode(true);
    setItems((prev) => [
      ...prev,
      {
        wood_product_id: null,
        orden: prev.length + 1,
        data: {
          ...EMPTY_WOOD_DATA,
          nombre: pieza.data.nombre,
          sku: pieza.data.sku,
          imagen: pieza.data.imagen,
        },
      },
    ]);
  }

  function removeItem(index: number) {
    setDirty(true);
    setItems((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSave() {
    if (!user || !token) return;
    const actor = { id: user.id, token };
    setSaving(true);
    setError(null);
    try {
      await saveWoodItems(actor, productId, items);
      const refreshed = await getWoodItems(productId);
      setItems(refreshed);
      setSavedItems(refreshed);
      setDirty(false);
      setEditMode(false);
      setShowToast(true);
    } catch (err) {
      setError(`No se pudo guardar: ${String(err)}`);
      logEventAsActor(actor, "ERROR", `No se pudo guardar Maderas del producto ${productId}: ${String(err)}`);
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

  function handleBackClick() {
    if (dirty && !confirm("Hay cambios sin guardar. ¿Salir de todas formas?")) return;
    onBack();
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

  if (loadError) {
    return (
      <div className="private-section">
        <button className="btn-link" onClick={onBack}>
          ← Volver a la ficha técnica
        </button>
        <p className="form-error">{loadError}</p>
        <button type="button" className="btn btn-secondary" onClick={loadItems}>
          Reintentar
        </button>
      </div>
    );
  }

  const linkedIds = items
    .map((item) => item.wood_product_id)
    .filter((id): id is number => id !== null);

  // Una pieza deja de listarse aquí en cuanto tiene un producto de Maderas
  // con el mismo nombre+SKU (agregado vía addFromPieza o a mano) — sus
  // datos ya están representados en la lista editable de arriba, mostrar
  // ambas tarjetas a la vez se veía como si se hubiera duplicado el
  // producto (no era un duplicado real en la BD, solo dos tarjetas para lo
  // mismo en pantalla). Se recalcula en cada render, así que desaparece de
  // inmediato al agregar, sin esperar a Guardar.
  const piezasSinPromover = piezasMaderaLike.filter(
    (pieza) => !items.some((wood) => sameNombreSku(wood.data, pieza.data)),
  );

  return (
    <div className="private-section">
      <button className="btn-link" onClick={handleBackClick}>
        ← Volver a la ficha técnica
      </button>
      <h1>Maderas</h1>
      <p className="hint">
        Productos de madera usados en este juego. Cada uno vive en el catálogo de Maderas y puede
        reutilizarse en otros juegos sin volver a capturarlo.
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
          <p className="hint">No hay productos de madera registrados.</p>
        )}

        {items.map((item, index) => (
          <WoodItemCard
            key={item.id ?? `new-${index}`}
            item={item}
            editMode={editMode}
            onChange={(patch) => updateItemData(index, patch)}
            onPickImage={() => pickProductImage(index)}
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
          <button type="button" className="btn btn-secondary" onClick={handleCancel} disabled={saving}>
            Cancelar
          </button>
        </div>
      )}

      <Toast message="Guardado con éxito" show={showToast} onHide={() => setShowToast(false)} />

      {showPicker && (
        <WoodProductPicker
          excludeIds={linkedIds}
          onSelect={addExistingProduct}
          onClose={() => setShowPicker(false)}
        />
      )}

      {piezasSinPromover.length > 0 && (
        <div className="plastic-items-list" style={{ marginTop: "2rem" }}>
          <h2>Piezas de madera/MDF ya registradas en Piezas</h2>
          <p className="hint">
            Estas piezas viven en el catálogo de Piezas (no se duplican aquí) — se muestran también
            en esta sección porque su nombre o material sugiere que son madera/MDF. Para editar sus
            datos de Piezas, hazlo desde Piezas. Para agregarles Capas/Largo/Ancho/importes, usa
            "Agregar datos de madera": crea un producto de Maderas nuevo (con nombre, SKU y foto
            precargados desde esta pieza) en la lista editable de arriba, sin tocar ni duplicar la
            pieza original. Una vez agregada, esta tarjeta desaparece de aquí — sus datos ya viven en
            la lista editable de arriba, no en dos lugares a la vez.
          </p>
          {piezasSinPromover.map((item) => (
            <div className="plastic-item-card" key={item.id}>
              <div className="plastic-item-card-header">
                <h3>{item.data.nombre || "(sin nombre)"}</h3>
              </div>
              <div className="plastic-item-view-fields">
                <div className="plastic-item-view-field">
                  <span className="plastic-item-view-field-label">SKU</span>
                  <span className="plastic-item-view-field-value">{item.data.sku || "—"}</span>
                </div>
                <div className="plastic-item-view-field">
                  <span className="plastic-item-view-field-label">Material</span>
                  <span className="plastic-item-view-field-value">{item.data.material || "—"}</span>
                </div>
                <div className="plastic-item-view-field">
                  <span className="plastic-item-view-field-label">Dimensión</span>
                  <span className="plastic-item-view-field-value">{item.data.dimension || "—"}</span>
                </div>
              </div>
              <div className="form-actions">
                <button type="button" className="btn-link" onClick={onOpenPiezas}>
                  Ver en Piezas
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => addFromPieza(item)}>
                  Agregar datos de madera
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface WoodItemCardProps {
  item: WoodItem;
  editMode: boolean;
  onChange: (patch: Partial<WoodProductInput>) => void;
  onPickImage: () => void;
  onRemove: () => void;
}

function WoodItemCard({ item, editMode, onChange, onPickImage, onRemove }: WoodItemCardProps) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  useRevokeObjectUrl(imageSrc);

  useEffect(() => {
    let cancelled = false;
    getImageSrc(item.data.imagen)
      .then((src) => {
        if (!cancelled) setImageSrc(src);
      })
      .catch(() => {
        if (!cancelled) setImageSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [item.data.imagen]);

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
        {editMode ? (
          <WoodProductFields
            data={item.data}
            imageSrc={imageSrc}
            onChange={onChange}
            onPickImage={onPickImage}
          />
        ) : (
          <>
            <div className="plastic-item-view-fields">
              {CAMPOS_VISTA.map((campo) => (
                <div className="plastic-item-view-field" key={campo.key}>
                  <span className="plastic-item-view-field-label">{campo.label}</span>
                  <span className="plastic-item-view-field-value">
                    {campo.tipo === "dinero"
                      ? formatWoodMoney(item.data[campo.key] as number | null)
                      : (item.data[campo.key] as string) || "—"}
                  </span>
                </div>
              ))}
            </div>
            <div className="wood-item-image-box">
              <span className="print-item-checks-label">Foto del producto</span>
              <div className="wood-item-image-frame">
                {imageSrc ? (
                  <img src={imageSrc} alt={item.data.nombre || "Producto de madera"} />
                ) : (
                  <span className="product-card-placeholder">Sin imagen</span>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
