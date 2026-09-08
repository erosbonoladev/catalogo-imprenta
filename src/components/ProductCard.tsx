import { useEffect, useState } from "react";
import { getImageSrc, getProductImage } from "../db";
import { useRevokeObjectUrl } from "../hooks/useRevokeObjectUrl";
import type { Product } from "../types";

interface Props {
  product: Product;
  onClick: () => void;
}

export default function ProductCard({ product, onClick }: Props) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  useRevokeObjectUrl(imageSrc);

  useEffect(() => {
    let cancelled = false;
    getProductImage(product.id)
      .then(getImageSrc)
      .then((src) => {
        if (!cancelled) setImageSrc(src);
      })
      .catch(() => {
        if (!cancelled) setImageSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [product.id]);

  return (
    <button className="product-card" onClick={onClick}>
      <div className="product-card-image">
        {imageSrc ? (
          <img src={imageSrc} alt={product.nombre} />
        ) : (
          <span className="product-card-placeholder">Sin imagen</span>
        )}
      </div>
      <div className="product-card-body">
        <span className="product-card-code">#{product.codigo}</span>
        <h3>{product.nombre}</h3>
        <p>{product.material}</p>
      </div>
    </button>
  );
}
