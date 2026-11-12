import { useEffect, useMemo, useState } from "react";
import { getImageSrc, getPlasticItems, getProductImage, normalizeSearchTerm, searchProducts } from "../db";
import { useRevokeObjectUrl } from "../hooks/useRevokeObjectUrl";
import type { PlasticItem, Product } from "../types";

interface Props {
  productId: number;
  linkedIds: number[];
  onConfirm: (kit: Product, items: PlasticItem[], copiarCantidades: boolean) => void;
  onClose: () => void;
}

const MAX_RESULTS = 50;

export default function KitPiezasModal({ productId, linkedIds, onConfirm, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [kit, setKit] = useState<Product | null>(null);
  const [kitItems, setKitItems] = useState<PlasticItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [askingCantidad, setAskingCantidad] = useState(false);

  useEffect(() => {
    let cancelled = false;
    searchProducts("")
      .then((list) => {
        if (!cancelled) setProducts(list);
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

  // Todas las palabras escritas deben aparecer (en cualquier orden) en el SKU,
  // el nombre o el material: "kit fracc" encuentra "Kit de Fracciones".
  const results = useMemo(() => {
    const tokens = normalizeSearchTerm(query.trim()).split(/\s+/).filter(Boolean);
    const candidates = products.filter((p) => p.id !== productId);
    if (tokens.length === 0) return candidates;
    return candidates.filter((p) => {
      const haystack = normalizeSearchTerm(`${p.codigo} ${p.nombre} ${p.material}`);
      return tokens.every((t) => haystack.includes(t));
    });
  }, [products, query, productId]);

  async function openKit(product: Product) {
    setKit(product);
    setKitItems([]);
    setSelected(new Set());
    setLoadError(null);
    setLoadingItems(true);
    try {
      setKitItems(await getPlasticItems(product.id));
    } catch (err) {
      setLoadError(`No se pudieron cargar las piezas: ${String(err)}`);
    } finally {
      setLoadingItems(false);
    }
  }

  function backToSearch() {
    setKit(null);
    setKitItems([]);
    setSelected(new Set());
    setAskingCantidad(false);
    setLoadError(null);
  }

  const selectable = kitItems.filter(
    (item) => item.plastic_product_id !== null && !linkedIds.includes(item.plastic_product_id),
  );
  const allSelected = selectable.length > 0 && selectable.every((item) => selected.has(item.id!));

  function toggleItem(itemId: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(selectable.map((item) => item.id!)));
  }

  function finish(copiarCantidades: boolean) {
    if (!kit) return;
    onConfirm(
      kit,
      kitItems.filter((item) => selected.has(item.id!)),
      copiarCantidades,
    );
  }

  // Si ninguna de las piezas elegidas trae cantidad en el kit no hay nada que
  // copiar, así que no se pregunta.
  function handleConfirm() {
    const hayCantidades = kitItems.some((item) => selected.has(item.id!) && item.cantidad.trim() !== "");
    if (hayCantidades) setAskingCantidad(true);
    else finish(false);
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        {kit && askingCantidad ? (
          <>
            <h2>¿Y las cantidades?</h2>
            <p className="hint">
              Las {selected.size} pieza{selected.size === 1 ? "" : "s"} que marcaste tienen una cantidad
              en «{kit.nombre}». ¿Quieres traer esas cantidades o prefieres capturarlas tú en este
              producto? Después de agregarlas puedes cambiarlas antes de guardar.
            </p>
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={() => finish(true)}>
                Traer las cantidades del kit
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => finish(false)}>
                Las ingreso yo
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setAskingCantidad(false)}>
                Volver
              </button>
            </div>
          </>
        ) : !kit ? (
          <>
            <h2>Agregar piezas desde un Kit</h2>
            <p className="hint">Busca el producto (kit o juego) del que quieres traer piezas.</p>

            <input
              className="search-input"
              type="text"
              placeholder="Buscar por nombre, SKU o material…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />

            {loading ? (
              <p className="hint">Buscando…</p>
            ) : loadError ? (
              <p className="form-error">{loadError}</p>
            ) : results.length === 0 ? (
              <p className="hint">
                {query.trim() ? `No se encontraron productos para "${query.trim()}".` : "No hay productos."}
              </p>
            ) : (
              <div className="plastic-picker-results">
                {results.slice(0, MAX_RESULTS).map((p) => (
                  <KitProductRow key={p.id} product={p} onSelect={() => openKit(p)} />
                ))}
              </div>
            )}
            {results.length > MAX_RESULTS && (
              <p className="hint">
                Mostrando {MAX_RESULTS} de {results.length}. Escribe para afinar la búsqueda.
              </p>
            )}

            <div className="form-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Cancelar
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>{kit.nombre}</h2>
            <p className="hint">
              #{kit.codigo} · Marca las piezas que quieres agregar a este producto.
            </p>

            {loadingItems ? (
              <p className="hint">Cargando piezas…</p>
            ) : loadError ? (
              <p className="form-error">{loadError}</p>
            ) : kitItems.length === 0 ? (
              <p className="hint">Este producto no tiene piezas registradas.</p>
            ) : (
              <>
                <label className="kit-select-all">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    disabled={selectable.length === 0}
                    onChange={toggleAll}
                  />
                  <span>Seleccionar todo ({selectable.length})</span>
                </label>
                <div className="plastic-picker-results">
                  {kitItems.map((item) => {
                    const yaEsta =
                      item.plastic_product_id !== null && linkedIds.includes(item.plastic_product_id);
                    return (
                      <KitPiezaRow
                        key={item.id}
                        item={item}
                        yaEsta={yaEsta}
                        checked={selected.has(item.id!)}
                        onToggle={() => toggleItem(item.id!)}
                      />
                    );
                  })}
                </div>
              </>
            )}

            <div className="form-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleConfirm}
                disabled={selected.size === 0}
              >
                {selected.size > 0 ? `Agregar ${selected.size} pieza${selected.size === 1 ? "" : "s"}` : "Agregar"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={backToSearch}>
                Volver
              </button>
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Cancelar
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function KitProductRow({ product, onSelect }: { product: Product; onSelect: () => void }) {
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
    <button type="button" className="plastic-picker-row" onClick={onSelect}>
      {imageSrc ? (
        <img src={imageSrc} alt={product.nombre} className="piece-thumb" />
      ) : (
        <div className="piece-thumb piece-thumb-empty" />
      )}
      <div className="plastic-picker-row-info">
        <strong>{product.nombre || "(sin nombre)"}</strong>
        <span>{[`#${product.codigo}`, product.material].filter(Boolean).join(" · ")}</span>
      </div>
    </button>
  );
}

interface PiezaRowProps {
  item: PlasticItem;
  yaEsta: boolean;
  checked: boolean;
  onToggle: () => void;
}

function KitPiezaRow({ item, yaEsta, checked, onToggle }: PiezaRowProps) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  useRevokeObjectUrl(imageSrc);

  useEffect(() => {
    let cancelled = false;
    getImageSrc(item.data.imagen)
      .then((src) => {
        if (!cancelled) setImageSrc(src);
      })
      .catch(() => {
        if (!cancelled) setImageSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [item.data.imagen]);

  const detalle = [
    item.data.color && `Color: ${item.data.color}`,
    item.data.dimension && `Tamaño: ${item.data.dimension}`,
    item.data.sku && `SKU: ${item.data.sku}`,
  ].filter((d): d is string => Boolean(d));

  return (
    <label className={`kit-pieza-row${yaEsta ? " is-disabled" : ""}`}>
      <span className="kit-pieza-check">
        <input type="checkbox" checked={checked} disabled={yaEsta} onChange={onToggle} />
      </span>
      <span className="kit-pieza-media">
        {imageSrc ? (
          <img src={imageSrc} alt={item.data.nombre} />
        ) : (
          <span className="kit-pieza-media-empty" />
        )}
      </span>
      <div className="kit-pieza-info">
        <strong>{item.data.nombre || "(sin nombre)"}</strong>
        {yaEsta ? (
          <span>Ya está en este producto</span>
        ) : (
          <span className="kit-pieza-detalle">
            {detalle.length > 0 ? detalle.map((d) => <span key={d}>{d}</span>) : "—"}
          </span>
        )}
      </div>
    </label>
  );
}
