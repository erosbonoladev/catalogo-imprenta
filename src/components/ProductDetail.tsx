import { useEffect, useState } from "react";
import {
  deleteProduct,
  getImageSrc,
  getProduct,
  getProductDescriptions,
  getProductSpecs,
} from "../db";
import type { Product, ProductDescription, ProductSpec } from "../types";
import { buildDescriptionSlots } from "../descriptions";
import { hasPermission, useAuth } from "../auth";
import RequisicionModal from "./RequisicionModal";
import PreciosModal from "./PreciosModal";
import basuraIcon from "../../Assets/basura.svg";

interface Props {
  productId: number;
  onBack: () => void;
  onEdit: (id: number) => void;
  onDeleted: () => void;
  onOpenPlasticos: (productId: number) => void;
  onOpenImprenta: (productId: number) => void;
}

function formatFechaCorta(fechaSql: string): string {
  const [fecha] = fechaSql.split(" ");
  const [y, m, d] = fecha.split("-");
  return `${d}/${m}/${y}`;
}

export default function ProductDetail({
  productId,
  onBack,
  onEdit,
  onDeleted,
  onOpenPlasticos,
  onOpenImprenta,
}: Props) {
  const { user, token } = useAuth();
  const [product, setProduct] = useState<Product | null>(null);
  const [specs, setSpecs] = useState<ProductSpec[]>([]);
  const [descriptions, setDescriptions] = useState<ProductDescription[]>([]);
  const [descIndex, setDescIndex] = useState(0);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [barcodeSrc, setBarcodeSrc] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [requisicionSpec, setRequisicionSpec] = useState<ProductSpec | null>(null);
  const [showPrecios, setShowPrecios] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [prod, specList, descriptionList] = await Promise.all([
        getProduct(productId),
        getProductSpecs(productId),
        getProductDescriptions(productId),
      ]);
      if (cancelled) return;
      setProduct(prod);
      setSpecs(specList);
      setDescriptions(descriptionList);
      setDescIndex(0);
      setImageSrc(await getImageSrc(prod?.imagen ?? null));
      setBarcodeSrc(await getImageSrc(prod?.imagen_codigo_barras ?? null));
    })();
    return () => {
      cancelled = true;
    };
  }, [productId]);

  if (!product) {
    return (
      <div className="product-detail">
        <button className="btn-link" onClick={onBack}>
          ← Volver a la búsqueda
        </button>
        <p className="hint">Cargando…</p>
      </div>
    );
  }

  async function handleDelete() {
    if (!user || !token) return;
    await deleteProduct({ id: user.id, token }, productId);
    onDeleted();
  }

  const descriptionSlots = buildDescriptionSlots(product.descripcion, descriptions).filter(
    (slot) => slot.texto.trim(),
  );
  const activeDescIndex = Math.min(descIndex, Math.max(0, descriptionSlots.length - 1));
  const activeDescSlot = descriptionSlots[activeDescIndex];

  return (
    <div className="product-detail">
      <button className="btn-link" onClick={onBack}>
        ← Volver a la búsqueda
      </button>

      <div className="product-detail-layout">
        <div className="product-detail-media">
          <div className="product-detail-image">
            {imageSrc ? (
              <img src={imageSrc} alt={product.nombre} />
            ) : (
              <span className="product-card-placeholder">Sin imagen</span>
            )}
          </div>
          <div className="barcode-box">
            {barcodeSrc ? (
              <img src={barcodeSrc} alt="Código de barras" />
            ) : (
              <span className="product-card-placeholder">Sin código de barras</span>
            )}
          </div>
        </div>

        <div className="product-detail-info">
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <span className="product-card-code">#{product.codigo}</span>
            {hasPermission(user, "precios_ver") && (
              <button type="button" className="btn-link" onClick={() => setShowPrecios(true)}>
                Precios
              </button>
            )}
          </div>
          <h1>{product.nombre}</h1>
          <p className="product-detail-tags">
            {product.categoria && <span className="tag">{product.categoria}</span>}
            {product.material && <span className="tag">{product.material}</span>}
          </p>

          {activeDescSlot && (
            <div className="description-viewer">
              <div className="description-viewer-header">
                <button
                  type="button"
                  className="icon-btn description-nav-btn"
                  onClick={() => setDescIndex((i) => i - 1)}
                  disabled={activeDescIndex <= 0}
                  aria-label="Descripción anterior"
                >
                  ‹
                </button>
                <span className="description-viewer-label">{activeDescSlot.etiqueta}</span>
                <button
                  type="button"
                  className="icon-btn description-nav-btn"
                  onClick={() => setDescIndex((i) => i + 1)}
                  disabled={activeDescIndex >= descriptionSlots.length - 1}
                  aria-label="Siguiente descripción"
                >
                  ›
                </button>
              </div>
              <p className="product-detail-description">{activeDescSlot.texto}</p>
            </div>
          )}

          {specs.length > 0 && (
            <table className="specs-table">
              <tbody>
                {specs.map((spec) => (
                  <tr key={spec.id}>
                    <th>{spec.etiqueta}</th>
                    <td>{spec.valor}</td>
                    <td className="specs-table-actions">
                      {spec.permite_requisicion && hasPermission(user, "requisiciones") && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-requisicion"
                          onClick={() => setRequisicionSpec(spec)}
                        >
                          Requisición
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {product.presentacion_original && (
            <details className="presentacion-original">
              <summary>Ver texto original de Presentación / Contenido</summary>
              <p>{product.presentacion_original}</p>
            </details>
          )}

          <div className="product-detail-actions">
            <button className="btn btn-primary" onClick={() => onEdit(product.id)}>
              Editar ficha
            </button>
            {hasPermission(user, "plasticos") && (
              <button
                className="btn btn-secondary"
                onClick={() => onOpenPlasticos(product.id)}
              >
                Piezas
              </button>
            )}
            {hasPermission(user, "imprenta") && (
              <button
                className="btn btn-secondary"
                onClick={() => onOpenImprenta(product.id)}
              >
                Imprenta
              </button>
            )}
            {confirmingDelete ? (
              <span className="confirm-delete">
                ¿Eliminar este producto?
                <button className="btn btn-danger" onClick={handleDelete}>
                  Sí, eliminar
                </button>
                <button className="btn-link" onClick={() => setConfirmingDelete(false)}>
                  Cancelar
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="icon-btn icon-btn-remove"
                onClick={() => setConfirmingDelete(true)}
                title="Eliminar producto"
                aria-label="Eliminar producto"
              >
                <img src={basuraIcon} alt="" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>

      {requisicionSpec && (
        <RequisicionModal
          product={product}
          etiqueta={requisicionSpec.etiqueta}
          descripcion={requisicionSpec.valor}
          onClose={() => setRequisicionSpec(null)}
        />
      )}

      {showPrecios && <PreciosModal product={product} onClose={() => setShowPrecios(false)} />}

      <p className="last-modified">
        Última modificación: {formatFechaCorta(product.actualizado_en)}
      </p>
    </div>
  );
}
