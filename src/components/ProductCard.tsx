import { useEffect, useState } from "react";
import { getImageSrc } from "../db";
import type { Product } from "../types";

interface Props {
  product: Product;
  onClick: () => void;
}

export default function ProductCard({ product, onClick }: Props) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getImageSrc(product.imagen).then((src) => {
      if (!cancelled) setImageSrc(src);
    });
    return () => {
      cancelled = true;
    };
  }, [product.imagen]);

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
