import { useEffect, useState } from "react";
import { searchProducts } from "../db";
import type { Product, SearchFilter } from "../types";
import ProductCard from "./ProductCard";
import Pagination from "./Pagination";

interface Props {
  query: string;
  filter: SearchFilter;
  page: number;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: SearchFilter) => void;
  onPageChange: (page: number) => void;
  onSelect: (id: number) => void;
  onNew: () => void;
}

const FILTROS: { value: SearchFilter; label: string }[] = [
  { value: "todo", label: "Todo" },
  { value: "nombre", label: "Nombre o palabras clave" },
  { value: "sku", label: "SKU" },
  { value: "material", label: "Material" },
  { value: "codigo_barras", label: "Código de barras" },
];

const PAGE_SIZE = 20; // 5 filas x 4 columnas por página

export default function SearchScreen({
  query,
  filter,
  page,
  onQueryChange,
  onFilterChange,
  onPageChange,
  onSelect,
  onNew,
}: Props) {
  const [results, setResults] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    const timer = setTimeout(async () => {
      try {
        const products = await searchProducts(query, filter);
        if (!cancelled) {
          setResults(products);
          onPageChange(1);
        }
      } catch (err) {
        if (!cancelled) setLoadError(`No se pudo buscar: ${String(err)}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, filter]);

  const totalPages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));

  useEffect(() => {
    if (page > totalPages) onPageChange(totalPages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalPages]);

  const currentPage = Math.min(page, totalPages);
  const pageResults = results.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  return (
    <div className="search-screen">
      <header className="search-header">
        <h1>Clio</h1>
        <div className="search-header-actions">
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
        onChange={(e) => onQueryChange(e.target.value)}
        autoFocus
      />

      <div className="search-filters" role="group" aria-label="Filtrar búsqueda por">
        {FILTROS.map((f) => (
          <button
            key={f.value}
            type="button"
            className={`filter-chip${filter === f.value ? " filter-chip-active" : ""}`}
            onClick={() => onFilterChange(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="hint">Buscando…</p>
      ) : loadError ? (
        <p className="form-error">{loadError}</p>
      ) : results.length === 0 ? (
        <p className="hint">
          {query.trim()
            ? `No se encontraron productos para "${query.trim()}".`
            : "Aún no hay productos en el catálogo. Agrega el primero."}
        </p>
      ) : (
        <>
          <div className="results-grid">
            {pageResults.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                onClick={() => onSelect(product.id)}
              />
            ))}
          </div>
          {totalPages > 1 && (
            <Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              onChange={onPageChange}
            />
          )}
        </>
      )}
    </div>
  );
}
