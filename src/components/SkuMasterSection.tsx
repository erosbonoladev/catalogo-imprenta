import { useEffect, useMemo, useState } from "react";
import {
  getPreciosList,
  getSkuMasterExportData,
  listPlasticProductsSummary,
  logEventAsActor,
  saveBackupFileAs,
  searchProducts,
  updatePlasticProductSku,
} from "../db";
import type { PlasticProduct, Precio, Product } from "../types";
import { computeSkuPrincipal } from "../precios";
import { buildSkuMasterWorkbook } from "../excelExport";
import { hasPermission, useAuth } from "../auth";
import Pagination from "./Pagination";
import Toast from "./Toast";
import AutoGrowInput from "./AutoGrowInput";

interface Props {
  onBack: () => void;
  onOpenProduct: (productId: number) => void;
  onOpenPieza: (plasticProductId: number) => void;
}

type Tab = "todos" | "sin-sku";

const PAGE_SIZE = 25;

interface SkuGroup {
  key: string;
  skuPrincipal: string;
  productos: Product[];
  piezas: PlasticProduct[];
  precios: Precio[];
}

export default function SkuMasterSection({ onBack, onOpenProduct, onOpenPieza }: Props) {
  const { user, token } = useAuth();
  const allowed = hasPermission(user, "sku_master");

  const [productos, setProductos] = useState<Product[]>([]);
  const [piezas, setPiezas] = useState<PlasticProduct[]>([]);
  const [precios, setPrecios] = useState<Precio[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("todos");
  const [query, setQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  async function refresh() {
    if (!user || !token) return;
    const [productList, piezaList, precioList] = await Promise.all([
      searchProducts(""),
      listPlasticProductsSummary(),
      getPreciosList({ id: user.id, token }),
    ]);
    setProductos(productList);
    setPiezas(piezaList);
    setPrecios(precioList);
    setLoading(false);
  }

  async function handleExportar() {
    if (!user || !token || exporting) return;
    const actor = { id: user.id, token };
    setExporting(true);
    try {
      const data = await getSkuMasterExportData(actor);
      const bytes = buildSkuMasterWorkbook(data);
      const saved = await saveBackupFileAs("SKU Master.xlsx", bytes);
      if (saved) {
        await logEventAsActor(actor, "INFO", "SKU Master exportado a Excel.");
        setToastMessage("Excel de SKU Master generado.");
      }
    } catch (err) {
      setToastMessage(`No se pudo exportar: ${String(err)}`);
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    if (!allowed) return;
    refresh();
  }, [allowed, user, token]);

  useEffect(() => {
    if (allowed || !user || !token) return;
    logEventAsActor({ id: user.id, token }, "WARNING", `Acceso denegado a SKU Master para ${user.username}`);
  }, [allowed, user, token]);

  // Agrupa por SKU principal (misma regla que Precios, ver computeSkuPrincipal
  // en src/precios.ts) para mostrar qué ficha/pieza/precio comparten la misma
  // nomenclatura, aunque vengan de tres tablas distintas.
  const grupos = useMemo(() => {
    const map = new Map<string, SkuGroup>();
    function getGroup(rawSku: string): SkuGroup | null {
      const skuPrincipal = computeSkuPrincipal(rawSku);
      if (!skuPrincipal) return null;
      const key = skuPrincipal.toUpperCase();
      let group = map.get(key);
      if (!group) {
        group = { key, skuPrincipal, productos: [], piezas: [], precios: [] };
        map.set(key, group);
      }
      return group;
    }
    for (const p of productos) {
      getGroup(p.codigo)?.productos.push(p);
    }
    for (const p of piezas) {
      if (!p.sku.trim()) continue;
      getGroup(p.sku)?.piezas.push(p);
    }
    for (const p of precios) {
      getGroup(p.sku_principal || p.sku)?.precios.push(p);
    }
    return Array.from(map.values()).sort((a, b) => a.skuPrincipal.localeCompare(b.skuPrincipal));
  }, [productos, piezas, precios]);

  const piezasSinSku = useMemo(() => piezas.filter((p) => !p.sku.trim()), [piezas]);

  const filteredGrupos = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return grupos;
    return grupos.filter(
      (g) =>
        g.skuPrincipal.toLowerCase().includes(trimmed) ||
        g.productos.some(
          (p) => p.codigo.toLowerCase().includes(trimmed) || p.nombre.toLowerCase().includes(trimmed),
        ) ||
        g.piezas.some(
          (p) => p.sku.toLowerCase().includes(trimmed) || p.nombre.toLowerCase().includes(trimmed),
        ) ||
        g.precios.some(
          (p) => p.sku.toLowerCase().includes(trimmed) || p.nombre.toLowerCase().includes(trimmed),
        ),
    );
  }, [grupos, query]);

  const filteredPiezasSinSku = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return piezasSinSku;
    return piezasSinSku.filter(
      (p) =>
        p.nombre.toLowerCase().includes(trimmed) ||
        p.color.toLowerCase().includes(trimmed) ||
        p.material.toLowerCase().includes(trimmed),
    );
  }, [piezasSinSku, query]);

  useEffect(() => {
    setCurrentPage(1);
  }, [query, tab]);

  const totalPages = Math.max(
    1,
    Math.ceil((tab === "todos" ? filteredGrupos.length : filteredPiezasSinSku.length) / PAGE_SIZE),
  );

  useEffect(() => {
    setCurrentPage((page) => Math.min(page, totalPages));
  }, [totalPages]);

  const pageGrupos = filteredGrupos.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const pagePiezasSinSku = filteredPiezasSinSku.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  if (!allowed) {
    return (
      <div className="private-section">
        <button className="btn-link" onClick={onBack}>
          ← Volver
        </button>
        <h1>Acceso denegado</h1>
        <p className="hint">No tienes permiso para ver esta sección.</p>
      </div>
    );
  }

  async function handleGuardarSku(pieza: PlasticProduct) {
    if (!user || !token) return;
    const nuevoSku = (drafts[pieza.id] ?? "").trim();
    if (!nuevoSku) return;
    setSavingId(pieza.id);
    try {
      await updatePlasticProductSku({ id: user.id, token }, pieza.id, nuevoSku);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[pieza.id];
        return next;
      });
      await refresh();
      setToastMessage("SKU asignado.");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="private-section">
      <button className="btn-link" onClick={onBack}>
        ← Volver al menú principal
      </button>
      <h1>SKU Master</h1>
      <p className="hint">
        Todos los elementos del catálogo (fichas técnicas, piezas y precios) con su SKU y, cuando
        siguen la misma nomenclatura, el vínculo entre ellos.
      </p>

      <div className="form-actions">
        <button type="button" className="btn btn-secondary" onClick={handleExportar} disabled={exporting}>
          {exporting ? "Generando…" : "Exportar a Excel"}
        </button>
      </div>

      <div className="search-filters" role="group" aria-label="Sección de SKU Master">
        <button
          type="button"
          className={`filter-chip${tab === "todos" ? " filter-chip-active" : ""}`}
          onClick={() => setTab("todos")}
        >
          Todos los SKU
        </button>
        <button
          type="button"
          className={`filter-chip${tab === "sin-sku" ? " filter-chip-active" : ""}`}
          onClick={() => setTab("sin-sku")}
        >
          Sin SKU{piezasSinSku.length > 0 ? ` (${piezasSinSku.length})` : ""}
        </button>
      </div>

      <input
        className="search-input"
        type="text"
        placeholder={
          tab === "todos" ? "Buscar por SKU o nombre…" : "Buscar por nombre, material o color…"
        }
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {loading ? (
        <p className="hint">Cargando…</p>
      ) : tab === "todos" ? (
        pageGrupos.length === 0 ? (
          <p className="hint">No se encontraron SKU.</p>
        ) : (
          <>
            <div className="import-review-table-wrap">
              <table className="import-review-table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Vínculo</th>
                    <th>Ficha técnica</th>
                    <th>Piezas</th>
                    <th>Precios</th>
                  </tr>
                </thead>
                <tbody>
                  {pageGrupos.map((g) => {
                    const categorias = [
                      g.productos.length > 0,
                      g.piezas.length > 0,
                      g.precios.length > 0,
                    ].filter(Boolean).length;
                    return (
                      <tr key={g.key}>
                        <td>{g.skuPrincipal}</td>
                        <td>
                          <span
                            className={`import-status-badge ${
                              categorias > 1 ? "import-status-nueva" : "import-status-no-encontrado"
                            }`}
                          >
                            {categorias > 1 ? "Vinculado" : "Sin vínculo"}
                          </span>
                        </td>
                        <td>
                          {g.productos.length === 0
                            ? "—"
                            : g.productos.map((p) => (
                                <div key={p.id}>
                                  <button
                                    type="button"
                                    className="btn-link"
                                    onClick={() => onOpenProduct(p.id)}
                                  >
                                    {p.codigo} — {p.nombre || "(sin nombre)"}
                                  </button>
                                </div>
                              ))}
                        </td>
                        <td>
                          {g.piezas.length === 0
                            ? "—"
                            : g.piezas.map((p) => (
                                <div key={p.id}>
                                  <button
                                    type="button"
                                    className="btn-link"
                                    onClick={() => onOpenPieza(p.id)}
                                  >
                                    {p.sku} — {p.nombre || "(sin nombre)"}
                                  </button>
                                </div>
                              ))}
                        </td>
                        <td>
                          {g.precios.length === 0
                            ? "—"
                            : g.precios.map((p) => (
                                <div key={p.id}>
                                  {p.sku} — {p.nombre || "(sin nombre)"}
                                </div>
                              ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && (
              <Pagination currentPage={currentPage} totalPages={totalPages} onChange={setCurrentPage} />
            )}
          </>
        )
      ) : pagePiezasSinSku.length === 0 ? (
        <p className="hint">
          {piezasSinSku.length === 0
            ? "Todas las piezas registradas ya tienen un SKU asignado."
            : "No se encontraron piezas para esa búsqueda."}
        </p>
      ) : (
        <>
          <div className="import-review-table-wrap">
            <table className="import-review-table">
              <thead>
                <tr>
                  <th>Nombre de la pieza</th>
                  <th>Material</th>
                  <th>Color</th>
                  <th>Origen</th>
                  <th>Asignar SKU</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {pagePiezasSinSku.map((p) => {
                  const draft = drafts[p.id] ?? "";
                  return (
                    <tr key={p.id}>
                      <td>{p.nombre || "(sin nombre)"}</td>
                      <td>{p.material || "—"}</td>
                      <td>{p.color || "—"}</td>
                      <td>{p.origen || "—"}</td>
                      <td>
                        <AutoGrowInput
                          value={draft}
                          onChange={(v) => setDrafts((prev) => ({ ...prev, [p.id]: v }))}
                          placeholder="Nuevo SKU"
                        />
                      </td>
                      <td className="backups-history-actions">
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => handleGuardarSku(p)}
                          disabled={savingId === p.id || !draft.trim()}
                        >
                          {savingId === p.id ? "Guardando…" : "Guardar"}
                        </button>
                        <button type="button" className="btn-link" onClick={() => onOpenPieza(p.id)}>
                          Ver especificaciones
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <Pagination currentPage={currentPage} totalPages={totalPages} onChange={setCurrentPage} />
          )}
        </>
      )}

      <Toast message={toastMessage ?? ""} show={!!toastMessage} onHide={() => setToastMessage(null)} />
    </div>
  );
}
