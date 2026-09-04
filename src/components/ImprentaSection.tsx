import { useEffect, useState } from "react";
import {
  deletePrintItemOrder,
  deletePrintItemPurchase,
  getPrintItemOrders,
  getPrintItemPurchases,
  getPrintItems,
  savePrintItems,
  getProduct,
  logEvent,
} from "../db";
import type {
  ImageBlob,
  PlacasExistentes,
  PrintItem,
  PrintItemCheck,
  PrintItemExtra,
  PrintItemOrder,
  PrintItemPurchase,
  Product,
} from "../types";
import { PROCESOS_IMPRENTA } from "../types";
import { hasPermission, useAuth } from "../auth";
import AutoGrowInput from "./AutoGrowInput";
import Toast from "./Toast";
import OrderModal from "./OrderModal";
import PrintItemImagesCarousel from "./PrintItemImagesCarousel";
import basuraIcon from "../../Assets/basura.svg";

interface Props {
  productId: number;
  onBack: () => void;
}

const TIPOS_PAPEL = ["Bond", "Sulfatada", "Cartulina", "Couché", "Opalina", "Kraft"];

const PLACAS_EXISTENTES_LABEL: Record<PlacasExistentes, string> = {
  "": "Sin definir",
  si: "Sí",
  no: "No",
};

const CAMPOS_VISTA: { label: string; key: keyof PrintItem; format?: (v: string) => string }[] = [
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
  { label: "Número de placas", key: "numero_placas" },
  {
    label: "Placas existentes",
    key: "placas_existentes",
    format: (v) => PLACAS_EXISTENTES_LABEL[v as PlacasExistentes] ?? "Sin definir",
  },
];

function maxImagesFromPliegos(numeroPliegos: string): number {
  const n = parseInt(numeroPliegos.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function formatFecha(iso: string): string {
  const withZone = iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("es-MX");
}

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
    numero_placas: "",
    placas_existentes: "",
    checks: PROCESOS_IMPRENTA.map((nombre, i) => ({ nombre, marcado: false, orden: i + 1 })),
    extras: [],
    images: [],
    acabados: "",
    notas: "",
    orden,
  };
}

export default function ImprentaSection({ productId, onBack }: Props) {
  const { user, token } = useAuth();
  const allowed = hasPermission(user, "imprenta");
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
  const [historyOpen, setHistoryOpen] = useState<Record<number, boolean>>({});
  const [historyLoading, setHistoryLoading] = useState<Record<number, boolean>>({});
  const [ordersByItem, setOrdersByItem] = useState<Record<number, PrintItemOrder[]>>({});
  const [purchasesByOrder, setPurchasesByOrder] = useState<Record<number, PrintItemPurchase[]>>({});

  useEffect(() => {
    if (!allowed) return;
    Promise.all([getPrintItems(productId), getProduct(productId)]).then(([i, p]) => {
      setItems(i);
      setSavedItems(i);
      setProduct(p);
      setLoading(false);
    });
  }, [productId, allowed]);

  useEffect(() => {
    if (allowed) return;
    logEvent(
      "WARNING",
      `Acceso denegado a Imprenta para ${user?.username ?? "desconocido"}`,
      user?.username ?? null,
    );
  }, [allowed, user?.username]);

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

  function addImage(itemIndex: number, image: ImageBlob) {
    setDirty(true);
    setItems((prev) =>
      prev.map((item, i) =>
        i === itemIndex
          ? { ...item, images: [...item.images, { imagen: image, orden: item.images.length + 1 }] }
          : item,
      ),
    );
  }

  function replaceImage(itemIndex: number, imageIndex: number, image: ImageBlob) {
    setDirty(true);
    setItems((prev) =>
      prev.map((item, i) =>
        i === itemIndex
          ? {
              ...item,
              images: item.images.map((img, ii) =>
                ii === imageIndex ? { ...img, imagen: image } : img,
              ),
            }
          : item,
      ),
    );
  }

  function removeImage(itemIndex: number, imageIndex: number) {
    setDirty(true);
    setItems((prev) =>
      prev.map((item, i) =>
        i === itemIndex
          ? { ...item, images: item.images.filter((_, ii) => ii !== imageIndex) }
          : item,
      ),
    );
  }

  async function handleSave() {
    if (!user || !token) return;
    setSaving(true);
    setError(null);
    try {
      await savePrintItems({ id: user.id, token }, productId, items);
      const refreshed = await getPrintItems(productId);
      setItems(refreshed);
      setSavedItems(refreshed);
      setDirty(false);
      setEditMode(false);
      setShowToast(true);
    } catch (err) {
      setError(`No se pudo guardar: ${String(err)}`);
      logEvent("ERROR", `No se pudo guardar Imprenta del producto ${productId}: ${String(err)}`, user?.username ?? null);
    } finally {
      setSaving(false);
    }
  }

  async function toggleHistory(item: PrintItem) {
    if (!item.id) return;
    const itemId = item.id;
    if (historyOpen[itemId]) {
      setHistoryOpen((prev) => ({ ...prev, [itemId]: false }));
      return;
    }
    setHistoryOpen((prev) => ({ ...prev, [itemId]: true }));
    setHistoryLoading((prev) => ({ ...prev, [itemId]: true }));
    const orders = await getPrintItemOrders(itemId);
    setOrdersByItem((prev) => ({ ...prev, [itemId]: orders }));
    const purchaseEntries = await Promise.all(
      orders.map(async (o) => [o.id, await getPrintItemPurchases(o.id)] as const),
    );
    setPurchasesByOrder((prev) => ({ ...prev, ...Object.fromEntries(purchaseEntries) }));
    setHistoryLoading((prev) => ({ ...prev, [itemId]: false }));
  }

  async function handleDeleteOrder(itemId: number, order: PrintItemOrder) {
    if (!user || !token) return;
    await deletePrintItemOrder({ id: user.id, token }, order.id);
    setOrdersByItem((prev) => ({
      ...prev,
      [itemId]: (prev[itemId] ?? []).filter((o) => o.id !== order.id),
    }));
    setPurchasesByOrder((prev) => {
      const next = { ...prev };
      delete next[order.id];
      return next;
    });
    logEvent(
      "INFO",
      `Orden de producción #${order.id} eliminada por ${user?.username ?? "desconocido"}`,
      user?.username ?? null,
    );
  }

  async function handleDeletePurchase(order: PrintItemOrder, purchase: PrintItemPurchase) {
    if (!user || !token) return;
    await deletePrintItemPurchase({ id: user.id, token }, purchase.id);
    setPurchasesByOrder((prev) => ({
      ...prev,
      [order.id]: (prev[order.id] ?? []).filter((p) => p.id !== purchase.id),
    }));
    logEvent(
      "INFO",
      `Compra #${purchase.id} eliminada por ${user?.username ?? "desconocido"}`,
      user?.username ?? null,
    );
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
                <button
                  type="button"
                  className="icon-btn icon-btn-remove"
                  onClick={() => removeItem(index)}
                  title="Quitar producto de impresión"
                  aria-label="Quitar producto de impresión"
                >
                  <img src={basuraIcon} alt="" aria-hidden="true" />
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
                <label>
                  Número de placas
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={item.numero_placas}
                    onChange={(e) => updateItem(index, "numero_placas", e.target.value)}
                  />
                </label>
                <label>
                  Placas existentes
                  <select
                    value={item.placas_existentes}
                    onChange={(e) =>
                      updateItem(index, "placas_existentes", e.target.value as PlacasExistentes)
                    }
                  >
                    <option value="">Sin definir</option>
                    <option value="si">Sí</option>
                    <option value="no">No</option>
                  </select>
                </label>
              </div>

              <div className="print-item-side-layout">
                <div className="print-item-side-main">
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
                          className="icon-btn icon-btn-remove"
                          onClick={() => removeExtra(index, extraIndex)}
                          title="Quitar segmento"
                          aria-label="Quitar segmento"
                        >
                          <img src={basuraIcon} alt="" aria-hidden="true" />
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

                <PrintItemImagesCarousel
                  images={item.images}
                  editable
                  maxImages={maxImagesFromPliegos(item.numero_pliegos)}
                  onAdd={(image) => addImage(index, image)}
                  onReplace={(imageIndex, image) => replaceImage(index, imageIndex, image)}
                  onRemove={(imageIndex) => removeImage(index, imageIndex)}
                />
              </div>
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
                      {campo.format
                        ? campo.format(item[campo.key] as string)
                        : (item[campo.key] as string) || "—"}
                    </span>
                  </div>
                ))}
              </div>

              <div className="print-item-side-layout">
                <div className="print-item-side-main">
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

                {item.images.length > 0 && (
                  <PrintItemImagesCarousel
                    images={item.images}
                    editable={false}
                    maxImages={0}
                    onAdd={() => {}}
                    onReplace={() => {}}
                    onRemove={() => {}}
                  />
                )}
              </div>

              {item.id && (
                <>
                  <button type="button" className="btn-link" onClick={() => toggleHistory(item)}>
                    {historyOpen[item.id]
                      ? "Ocultar historia de órdenes y compras"
                      : "Historia de órdenes y compras"}
                  </button>
                  {historyOpen[item.id] &&
                    (historyLoading[item.id] ? (
                      <p className="hint">Cargando…</p>
                    ) : (
                      <div className="print-item-history">
                        <span className="print-item-checks-label">Órdenes de producción</span>
                        {(ordersByItem[item.id] ?? []).length === 0 ? (
                          <p className="hint">
                            No hay órdenes de producción generadas para este ítem todavía.
                          </p>
                        ) : (
                          (ordersByItem[item.id] ?? []).map((order) => (
                            <div className="print-item-history-order" key={order.id}>
                              <div className="print-item-card-header">
                                <span className="print-item-checks-label">
                                  Orden de producción
                                </span>
                                <button
                                  type="button"
                                  className="icon-btn icon-btn-remove"
                                  onClick={() => handleDeleteOrder(item.id!, order)}
                                  title="Borrar orden de producción"
                                  aria-label="Borrar orden de producción"
                                >
                                  <img src={basuraIcon} alt="" aria-hidden="true" />
                                </button>
                              </div>
                              <div className="print-item-view-fields">
                                <div className="print-item-view-field">
                                  <span className="print-item-view-field-label">Folio</span>
                                  <span className="print-item-view-field-value">
                                    {order.folio || "—"}
                                  </span>
                                </div>
                                <div className="print-item-view-field">
                                  <span className="print-item-view-field-label">Fecha</span>
                                  <span className="print-item-view-field-value">
                                    {formatFecha(order.creado_en)}
                                  </span>
                                </div>
                                <div className="print-item-view-field">
                                  <span className="print-item-view-field-label">Merma</span>
                                  <span className="print-item-view-field-value">{order.merma}</span>
                                </div>
                                <div className="print-item-view-field">
                                  <span className="print-item-view-field-label">
                                    Cantidad de arte
                                  </span>
                                  <span className="print-item-view-field-value">
                                    {order.cantidad_arte}
                                  </span>
                                </div>
                                <div className="print-item-view-field">
                                  <span className="print-item-view-field-label">
                                    Número de tiros
                                  </span>
                                  <span className="print-item-view-field-value">
                                    {order.numero_tiros ?? "—"}
                                  </span>
                                </div>
                                <div className="print-item-view-field">
                                  <span className="print-item-view-field-label">
                                    Total de tamaños a imprimir con merma
                                  </span>
                                  <span className="print-item-view-field-value">
                                    {order.total_pliegos}
                                  </span>
                                </div>
                                <div className="print-item-view-field">
                                  <span className="print-item-view-field-label">
                                    Total de tamaños por pliego a imprimir
                                  </span>
                                  <span className="print-item-view-field-value">
                                    {order.numero_pliegos_usado > 0
                                      ? Math.ceil(order.total_pliegos / order.numero_pliegos_usado)
                                      : "—"}
                                  </span>
                                </div>
                              </div>
                            </div>
                          ))
                        )}

                        <div className="history-section-divider">
                          <span className="print-item-checks-label">Órdenes de compra</span>
                        </div>
                        {(() => {
                          const compras = (ordersByItem[item.id] ?? [])
                            .flatMap((order) =>
                              (purchasesByOrder[order.id] ?? []).map((p) => ({ ...p, order })),
                            )
                            .sort((a, b) => b.id - a.id);
                          return compras.length === 0 ? (
                            <p className="hint">
                              No hay órdenes de compra generadas para este ítem todavía.
                            </p>
                          ) : (
                            compras.map((p) => (
                              <div className="print-item-history-order" key={p.id}>
                                <div className="print-item-card-header">
                                  <span className="print-item-checks-label">Orden compra</span>
                                  <button
                                    type="button"
                                    className="icon-btn icon-btn-remove"
                                    onClick={() => handleDeletePurchase(p.order, p)}
                                    title="Borrar orden de compra"
                                    aria-label="Borrar orden de compra"
                                  >
                                    <img src={basuraIcon} alt="" aria-hidden="true" />
                                  </button>
                                </div>
                                <div className="print-item-view-fields">
                                  <div className="print-item-view-field">
                                    <span className="print-item-view-field-label">Folio</span>
                                    <span className="print-item-view-field-value">
                                      {p.folio || "—"}
                                    </span>
                                  </div>
                                  <div className="print-item-view-field">
                                    <span className="print-item-view-field-label">
                                      Folio de la orden
                                    </span>
                                    <span className="print-item-view-field-value">
                                      {p.order.folio || "—"}
                                    </span>
                                  </div>
                                  <div className="print-item-view-field">
                                    <span className="print-item-view-field-label">Papel</span>
                                    <span className="print-item-view-field-value">
                                      {p.papel || "—"}
                                    </span>
                                  </div>
                                  <div className="print-item-view-field">
                                    <span className="print-item-view-field-label">Cortes</span>
                                    <span className="print-item-view-field-value">{p.cortes}</span>
                                  </div>
                                  <div className="print-item-view-field">
                                    <span className="print-item-view-field-label">Cantidad</span>
                                    <span className="print-item-view-field-value">
                                      {p.cantidad}
                                    </span>
                                  </div>
                                  <div className="print-item-view-field">
                                    <span className="print-item-view-field-label">
                                      Total de tamaños
                                    </span>
                                    <span className="print-item-view-field-value">
                                      {p.total_tamanos}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            ))
                          );
                        })()}
                      </div>
                    ))}
                </>
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
          <button type="button" className="btn btn-secondary" onClick={handleCancel} disabled={saving}>
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
