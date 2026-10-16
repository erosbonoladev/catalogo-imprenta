import { useEffect, useMemo, useState } from "react";
import {
  getImageSrc,
  getPlasticProduct,
  getPlasticProductImage,
  listPlasticProductsSummary,
  normalizeSearchTerm,
} from "../db";
import { useRevokeObjectUrl } from "../hooks/useRevokeObjectUrl";
import type { PlasticProduct } from "../types";

interface Props {
  excludeIds: number[];
  onSelect: (producto: PlasticProduct) => void;
  onClose: () => void;
}

// Con miles de piezas, pintar todas (cada una pide su miniatura) es lo que
// hacía lento abrir el selector; se muestran las primeras coincidencias y se
// afina escribiendo.
const MAX_RESULTS = 50;

export default function PlasticProductPicker({ excludeIds, onSelect, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [all, setAll] = useState<PlasticProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listPlasticProductsSummary()
      .then((list) => {
        if (!cancelled) setAll(list);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(`No se pudo buscar: ${String(err)}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const results = useMemo(() => {
    const term = normalizeSearchTerm(query.trim());
    if (!term) return all;
    return all.filter(
      (p) =>
        normalizeSearchTerm(p.nombre).includes(term) ||
        normalizeSearchTerm(p.sku).includes(term) ||
        normalizeSearchTerm(p.color).includes(term),
    );
  }, [all, query]);

  // La ficha completa (con imagen) se pide solo al elegir: el llamador la
  // reenvía a updatePlasticProduct, que sobrescribiría la imagen con null si
  // llegara sin ella.
  async function handleSelect(resumen: PlasticProduct) {
    if (selecting) return;
    setSelecting(true);
    try {
      onSelect((await getPlasticProduct(resumen.id)) ?? resumen);
    } catch (err) {
      setLoadError(`No se pudo cargar la pieza: ${String(err)}`);
      setSelecting(false);
    }
  }

  const filtered = results.filter((producto) => !excludeIds.includes(producto.id));
  const visible = filtered.slice(0, MAX_RESULTS);

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
        ) : loadError ? (
          <p className="form-error">{loadError}</p>
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
                onSelect={() => handleSelect(producto)}
              />
            ))}
          </div>
        )}
        {filtered.length > MAX_RESULTS && (
          <p className="hint">
            Mostrando {MAX_RESULTS} de {filtered.length}. Escribe para afinar la búsqueda.
          </p>
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
  useRevokeObjectUrl(imageSrc);

  useEffect(() => {
    let cancelled = false;
    getPlasticProductImage(producto.id)
      .then((imagen) => getImageSrc(imagen))
      .then((src) => {
        if (!cancelled) setImageSrc(src);
      })
      .catch(() => {
        if (!cancelled) setImageSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [producto.id]);

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
