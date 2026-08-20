import { useEffect, useState } from "react";
import { searchProducts } from "../db";
import type { Product } from "../types";
import ProductCard from "./ProductCard";
import UpdateChecker from "./UpdateChecker";

interface Props {
  onSelect: (id: number) => void;
  onNew: () => void;
  onAdmin: () => void;
}

export default function SearchScreen({ onSelect, onNew, onAdmin }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      const products = await searchProducts(query);
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

  return (
    <div className="search-screen">
      <header className="search-header">
        <h1>Catálogo Imprenta</h1>
        <div className="search-header-actions">
          <UpdateChecker />
          <button className="btn btn-secondary" onClick={onAdmin}>
            🔒 Contraseñas
          </button>
          <button className="btn btn-primary" onClick={onNew}>
            + Agregar producto
          </button>
        </div>
      </header>

      <input
        className="search-input"
        type="text"
        placeholder="Buscar por nombre o código (ej. tangram, 3072)…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />

      {loading ? (
        <p className="hint">Buscando…</p>
      ) : results.length === 0 ? (
        <p className="hint">
          {query.trim()
            ? `No se encontraron productos para "${query.trim()}".`
            : "Aún no hay productos en el catálogo. Agrega el primero."}
        </p>
      ) : (
        <div className="results-grid">
          {results.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              onClick={() => onSelect(product.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
