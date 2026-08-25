import { useEffect, useState } from "react";
import { searchProducts } from "../db";
import type { Product, SearchFilter } from "../types";
import { hasPermission, useAuth } from "../auth";
import ProductCard from "./ProductCard";
import UpdateChecker from "./UpdateChecker";
import Pagination from "./Pagination";

interface Props {
  onSelect: (id: number) => void;
  onNew: () => void;
  onConfiguraciones: () => void;
}

const FILTROS: { value: SearchFilter; label: string }[] = [
  { value: "todo", label: "Todo" },
  { value: "nombre", label: "Nombre o palabras clave" },
  { value: "sku", label: "SKU" },
  { value: "material", label: "Material" },
];

const PAGE_SIZE = 20; // 5 filas x 4 columnas por página

export default function SearchScreen({ onSelect, onNew, onConfiguraciones }: Props) {
  const { user, logout } = useAuth();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SearchFilter>("todo");
  const [results, setResults] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      const products = await searchProducts(query, filter);
      if (!cancelled) {
        setResults(products);
        setLoading(false);
        setCurrentPage(1);
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, filter]);

  const totalPages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));

  useEffect(() => {
    setCurrentPage((page) => Math.min(page, totalPages));
  }, [totalPages]);

  const pageResults = results.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  return (
    <div className="search-screen">
      <header className="search-header">
        <h1>Catálogo Imprenta</h1>
        <div className="search-header-actions">
          <UpdateChecker />
          {user && <span className="current-user">{user.username}</span>}
          {hasPermission(user, "configuraciones") && (
            <button className="btn btn-secondary" onClick={onConfiguraciones}>
              Configuraciones
            </button>
          )}
          <button className="btn btn-primary" onClick={onNew}>
            + Agregar producto
          </button>
          <button className="btn btn-secondary" onClick={logout}>
            Cerrar sesión
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

      <div className="search-filters" role="group" aria-label="Filtrar búsqueda por">
        {FILTROS.map((f) => (
          <button
            key={f.value}
            type="button"
            className={`filter-chip${filter === f.value ? " filter-chip-active" : ""}`}
            onClick={() => setFilter(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="hint">Buscando…</p>
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
              onChange={setCurrentPage}
            />
          )}
        </>
      )}
    </div>
  );
}
