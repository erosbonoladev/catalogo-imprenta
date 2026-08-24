import { useEffect, useState } from "react";
import { deleteProduct, getImageSrc, getProduct, getProductSpecs } from "../db";
import type { Product, ProductSpec } from "../types";
import { hasPermission, useAuth } from "../auth";

interface Props {
  productId: number;
  onBack: () => void;
  onEdit: (id: number) => void;
  onDeleted: () => void;
  onOpenPlasticos: (productId: number) => void;
  onOpenImprenta: (productId: number) => void;
}

export default function ProductDetail({
  productId,
  onBack,
  onEdit,
  onDeleted,
  onOpenPlasticos,
  onOpenImprenta,
}: Props) {
  const { user } = useAuth();
  const [product, setProduct] = useState<Product | null>(null);
  const [specs, setSpecs] = useState<ProductSpec[]>([]);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [prod, specList] = await Promise.all([
        getProduct(productId),
        getProductSpecs(productId),
      ]);
      if (cancelled) return;
      setProduct(prod);
      setSpecs(specList);
      setImageSrc(await getImageSrc(prod?.imagen ?? null));
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
    await deleteProduct(productId);
    onDeleted();
  }

  return (
    <div className="product-detail">
      <button className="btn-link" onClick={onBack}>
        ← Volver a la búsqueda
      </button>

      <div className="product-detail-layout">
        <div className="product-detail-image">
          {imageSrc ? (
            <img src={imageSrc} alt={product.nombre} />
          ) : (
            <span className="product-card-placeholder">Sin imagen</span>
          )}
        </div>

        <div className="product-detail-info">
          <span className="product-card-code">#{product.codigo}</span>
          <h1>{product.nombre}</h1>
          <p className="product-detail-tags">
            {product.categoria && <span className="tag">{product.categoria}</span>}
            {product.material && <span className="tag">{product.material}</span>}
          </p>

          {product.descripcion && (
            <p className="product-detail-description">{product.descripcion}</p>
          )}

          {specs.length > 0 && (
            <table className="specs-table">
              <tbody>
                {specs.map((spec) => (
                  <tr key={spec.id}>
                    <th>{spec.etiqueta}</th>
                    <td>{spec.valor}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
                Plásticos
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
                className="btn btn-secondary"
                onClick={() => setConfirmingDelete(true)}
              >
                Eliminar
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
