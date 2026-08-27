import { useEffect, useState } from "react";
import { getImageSrc, searchPlasticProducts } from "../db";
import type { PlasticProduct } from "../types";

interface Props {
  excludeIds: number[];
  onSelect: (producto: PlasticProduct) => void;
  onClose: () => void;
}

export default function PlasticProductPicker({ excludeIds, onSelect, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlasticProduct[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      const products = await searchPlasticProducts(query);
      if (!cancelled) {
        setResults(products);
        setLoading(false);
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const visible = results.filter((producto) => !excludeIds.includes(producto.id));

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        <h2>Agregar un producto existente</h2>

        <input
          className="search-input"
          type="text"
          placeholder="Buscar por nombre, SKU o color…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />

        {loading ? (
          <p className="hint">Buscando…</p>
        ) : visible.length === 0 ? (
          <p className="hint">
            {query.trim()
              ? `No se encontraron productos para "${query.trim()}".`
              : "Aún no hay productos en el catálogo de Piezas."}
          </p>
        ) : (
          <div className="plastic-picker-results">
            {visible.map((producto) => (
              <PlasticPickerRow
                key={producto.id}
                producto={producto}
                onSelect={() => onSelect(producto)}
              />
            ))}
          </div>
        )}

        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  producto: PlasticProduct;
  onSelect: () => void;
}

function PlasticPickerRow({ producto, onSelect }: RowProps) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getImageSrc(producto.imagen).then((src) => {
      if (!cancelled) setImageSrc(src);
    });
    return () => {
      cancelled = true;
    };
  }, [producto.imagen]);

  return (
    <button type="button" className="plastic-picker-row" onClick={onSelect}>
      {imageSrc ? (
        <img src={imageSrc} alt={producto.nombre} className="piece-thumb" />
      ) : (
        <div className="piece-thumb piece-thumb-empty" />
      )}
      <div className="plastic-picker-row-info">
        <strong>{producto.nombre || "(sin nombre)"}</strong>
        <span>{[producto.sku, producto.color].filter(Boolean).join(" · ") || "—"}</span>
      </div>
    </button>
  );
}
