import { useEffect, useState } from "react";
import { getCatalogoProgreso, searchProducts } from "../db";
import { useAuth } from "../auth";
import type { CatalogoFaltante, Product, SearchFilter } from "../types";
import ProductCard from "./ProductCard";
import Pagination from "./Pagination";

interface Props {
  query: string;
  filter: SearchFilter;
  page: number;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: SearchFilter) => void;
  faltantes: CatalogoFaltante | null;
  onFaltantesChange: (faltantes: CatalogoFaltante | null) => void;
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

const FALTANTES_LABEL: Record<CatalogoFaltante, string> = {
  piezas: "Artículos sin piezas",
  precios_venta: "Artículos sin precios de venta",
};

const PAGE_SIZE = 20; // 5 filas x 4 columnas por página

export default function SearchScreen({
  query,
  filter,
  page,
  onQueryChange,
  onFilterChange,
  faltantes,
  onFaltantesChange,
  onPageChange,
  onSelect,
  onNew,
}: Props) {
  const { user, token } = useAuth();
  const [results, setResults] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    const timer = setTimeout(async () => {
      try {
        let products = await searchProducts(query, filter);
        if (faltantes && user && token) {
          const progreso = await getCatalogoProgreso({ id: user.id, token });
          const ids = new Set(faltantes === "piezas" ? progreso.sinPiezas : progreso.sinPreciosVenta);
          products = products.filter((p) => ids.has(p.id));
        }
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
  }, [query, filter, faltantes]);

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

      {faltantes && (
        <div className="search-filters" role="group" aria-label="Filtro de faltantes">
          <button
            type="button"
            className="filter-chip filter-chip-active"
            title="Quitar filtro"
            onClick={() => onFaltantesChange(null)}
          >
            {FALTANTES_LABEL[faltantes]} ✕
          </button>
        </div>
      )}

      {loading ? (
        <p className="hint">Buscando…</p>
      ) : loadError ? (
        <p className="form-error">{loadError}</p>
      ) : results.length === 0 ? (
        <p className="hint">
          {faltantes && !query.trim()
            ? "¡Listo! No hay artículos pendientes en este filtro."
            : query.trim()
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
