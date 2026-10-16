import { Fragment, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { useAuth } from "../auth";
import { searchPrecios } from "../db";
import { formatMoney } from "../excelExport";
import * as L from "../remisionLayout";
import type { Precio, TipoRemision } from "../types";
import templateUrl from "../../Assets/remision-template.png";
import templateExternaUrl from "../../Assets/remision-template-externa.png";
import basuraIcon from "../../Assets/basura.svg";

export interface RenglonDraft {
  key: number;
  sku: string;
  productoNombre: string;
  cantidad: string;
  precioUnitario: string;
  // Solo true para renglones agregados por "Agregar manualmente" — son los
  // únicos candidatos a "Guardar producto" (los de búsqueda ya existen en
  // `precios`).
  manual: boolean;
}

export interface RenglonView extends RenglonDraft {
  cantidadNum: number;
  precioNum: number;
}

export interface SheetTotales {
  subtotal: number;
  descuento: number;
  iva: number;
  total: number;
  precioTexto: string;
}

export interface ClienteExterno {
  rfc: string;
  direccion: string;
  contacto: string;
  telefono: string;
}

type RowPatch = Partial<Pick<RenglonDraft, "cantidad" | "precioUnitario" | "sku" | "productoNombre">>;

interface Props {
  tipo: TipoRemision;
  fecha: string;
  pedido: string;
  onPedidoChange: (value: string) => void;
  // Solo externas: el nombre del cliente va en `pedido`, el resto aquí.
  cliente: ClienteExterno;
  onClienteChange: (campo: keyof ClienteExterno, value: string) => void;
  rows: RenglonView[];
  descuentoPct: string;
  onDescuentoChange: (value: string) => void;
  totales: SheetTotales;
  disabled: boolean;
  onUpdateRow: (key: number, patch: RowPatch) => void;
  onRemoveRow: (key: number) => void;
  // index === rows.length significa "renglón nuevo"; cualquier otro reemplaza
  // el producto de ese renglón conservando su cantidad.
  onPickPrecio: (index: number, precio: Precio) => void;
  // En internas `texto` es el SKU; en externas (sin columna Clave) es el nombre del producto.
  onAddManual: (index: number, texto: string) => void;
}

const pctX = (x: number) => `${(x / L.PAGE_W) * 100}%`;
const pctY = (y: number) => `${(y / L.PAGE_H) * 100}%`;

function box(x: number, y: number, w: number, h: number): CSSProperties {
  return { left: pctX(x), top: pctY(y), width: pctX(w), height: pctY(h) };
}

function centered(cx: number, cy: number, w: number, h: number): CSSProperties {
  return box(cx - w / 2, cy - h / 2, w, h);
}

function col(range: [number, number]): CSSProperties {
  return { left: pctX(range[0]), width: pctX(range[1] - range[0]) };
}

// Tamaño en pt de la plantilla escalado al ancho real de la hoja (--u, ver App.css).
function fs(pt: number): CSSProperties {
  return { fontSize: `max(10px, calc(var(--u) * ${pt}))` };
}

let measureCtx: CanvasRenderingContext2D | null = null;

// Mismo criterio que fitFontSize() en pdf.ts: el texto libre del encabezado
// se encoge hasta caber en vez de cortarse.
function fitSize(text: string, maxWidth: number, start: number, min: number): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return start;
  let size = start;
  while (size > min) {
    measureCtx.font = `${size}px Helvetica, Arial, sans-serif`;
    if (measureCtx.measureText(text).width <= maxWidth) break;
    size -= 0.5;
  }
  return size;
}

export default function RemisionSheet(props: Props) {
  const { tipo, rows, disabled } = props;
  const { user, token } = useAuth();
  const rootRef = useRef<HTMLDivElement>(null);

  const [searchIndex, setSearchIndex] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Precio[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [focusTarget, setFocusTarget] = useState<{ index: number; field: "cantidad" | "producto" } | null>(null);

  const externa = tipo === "externa";
  const C = L.columnsFor(tipo);
  // Columna donde se abre el buscador: Clave en internas, Producto en externas.
  const searchCol = C.clave ?? C.producto;
  const sheetCount = Math.floor(rows.length / L.ROWS_PER_PAGE) + 1;

  function openSearch(index: number) {
    if (disabled) return;
    setQuery("");
    setResults([]);
    setSearchError(null);
    setHighlight(0);
    setSearchIndex(index);
  }

  function closeSearch() {
    setSearchIndex(null);
    setQuery("");
    setResults([]);
    setSearchError(null);
  }

  useEffect(() => {
    if (searchIndex !== null && searchIndex > rows.length) closeSearch();
  }, [rows.length, searchIndex]);

  useEffect(() => {
    if (searchIndex === null || !query.trim()) {
      setResults([]);
      setSearchError(null);
      setBuscando(false);
      return;
    }
    if (!user || !token) return;
    const actor = { id: user.id, token };
    let cancelled = false;
    setBuscando(true);
    setSearchError(null);
    const timer = setTimeout(async () => {
      try {
        const precios = await searchPrecios(actor, query);
        if (!cancelled) {
          setResults(precios.slice(0, 8));
          setHighlight(0);
        }
      } catch (err) {
        if (!cancelled) {
          setResults([]);
          setSearchError(`No se pudo buscar: ${String(err)}`);
        }
      } finally {
        if (!cancelled) setBuscando(false);
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, searchIndex, user, token]);

  useEffect(() => {
    if (!focusTarget) return;
    const el = rootRef.current?.querySelector<HTMLInputElement>(
      `[data-rs-field="${focusTarget.field}"][data-rs-index="${focusTarget.index}"]`,
    );
    if (el) {
      el.focus();
      el.select();
      setFocusTarget(null);
    }
  }, [focusTarget, rows]);

  function pick(precio: Precio) {
    if (searchIndex === null) return;
    props.onPickPrecio(searchIndex, precio);
    setFocusTarget({ index: searchIndex, field: "cantidad" });
    closeSearch();
  }

  function addManual() {
    const sku = query.trim();
    if (searchIndex === null || !sku) return;
    props.onAddManual(searchIndex, sku);
    setFocusTarget({ index: searchIndex, field: externa ? "cantidad" : "producto" });
    closeSearch();
  }

  const optionCount = results.length + (query.trim() ? 1 : 0);

  function onSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearch();
    } else if (e.key === "ArrowDown" && optionCount > 0) {
      e.preventDefault();
      setHighlight((h) => (h + 1) % optionCount);
    } else if (e.key === "ArrowUp" && optionCount > 0) {
      e.preventDefault();
      setHighlight((h) => (h - 1 + optionCount) % optionCount);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlight < results.length) pick(results[highlight]);
      else if (query.trim()) addManual();
    }
  }

  const pedidoSize = fitSize(props.pedido || "—", L.PEDIDO.maxWidth, L.FONT_HEADER_FIELD, 6);

  function renderSearch(localRow: number) {
    const nearBottom = localRow > L.ROWS_PER_PAGE - 6;
    return (
      <>
        <input
          className="rs-search-input"
          style={{ left: pctX(searchCol[0]), width: pctX(300), ...fs(L.FONT_BODY) }}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKeyDown}
          onBlur={closeSearch}
          placeholder={externa ? "Buscar producto por nombre o SKU…" : "Buscar por SKU o nombre…"}
          aria-label="Buscar producto por SKU o nombre"
          autoFocus
        />
        {query.trim() && (
          <div
            className="rs-dropdown"
            role="listbox"
            // Evita que el clic en una opción le quite el foco al input (onBlur cerraría el menú antes del click).
            onMouseDown={(e) => e.preventDefault()}
            style={{
              left: pctX(searchCol[0]),
              width: pctX(330),
              ...(nearBottom ? { bottom: "calc(100% + 2px)" } : { top: "calc(100% + 2px)" }),
            }}
          >
            {buscando && results.length === 0 && <p className="rs-dropdown-hint">Buscando…</p>}
            {searchError && <p className="rs-dropdown-hint form-error">{searchError}</p>}
            {results.map((p, i) => (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={i === highlight}
                className={`rs-option${i === highlight ? " rs-option-active" : ""}`}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pick(p)}
              >
                {externa ? (
                  p.nombre
                ) : (
                  <>
                    <span className="product-card-code">#{p.sku}</span> {p.nombre} — {formatMoney(p.precio)}
                  </>
                )}
              </button>
            ))}
            {!buscando && !searchError && results.length === 0 && (
              <p className="rs-dropdown-hint">Sin resultados en el catálogo.</p>
            )}
            <button
              type="button"
              role="option"
              aria-selected={highlight === results.length}
              className={`rs-option rs-option-manual${highlight === results.length ? " rs-option-active" : ""}`}
              onMouseEnter={() => setHighlight(results.length)}
              onClick={addManual}
            >
              ¿No aparece? Agregar «{query.trim()}» manualmente
            </button>
          </div>
        )}
      </>
    );
  }

  function renderRow(globalIndex: number, localRow: number) {
    const row = rows[globalIndex];
    const isSlot = globalIndex === rows.length;
    const searching = searchIndex === globalIndex;
    const rowStyle: CSSProperties = { top: pctY(L.ROW_TOP0 + localRow * L.ROW_PITCH), height: pctY(L.ROW_PITCH) };

    if (!row) {
      return (
        <div key={`empty-${globalIndex}`} className="rs-row rs-row-empty" style={rowStyle}>
          {searching ? (
            renderSearch(localRow)
          ) : (
            <button
              type="button"
              className={`rs-cell rs-clave-empty${externa ? " rs-left" : ""}`}
              style={{
                ...col(searchCol),
                ...fs(L.FONT_BODY),
                ...(externa ? { paddingLeft: pctX(C.productoTextX - C.producto[0]) } : {}),
              }}
              onClick={() => openSearch(rows.length)}
              disabled={disabled}
              aria-label={isSlot ? "Agregar producto" : "Agregar producto al siguiente renglón"}
            >
              {isSlot && <span className="rs-placeholder">{externa ? "Buscar producto" : "Buscar"}</span>}
            </button>
          )}
        </div>
      );
    }

    const importe = row.cantidadNum * row.precioNum;
    const productoPad = pctX(C.productoTextX - C.producto[0]);
    return (
      <div key={row.key} className="rs-row" style={rowStyle}>
        {C.clave &&
          (searching ? (
            renderSearch(localRow)
          ) : row.manual ? (
            <input
              className="rs-cell rs-input rs-center"
              style={{ ...col(C.clave), ...fs(L.FONT_BODY) }}
              value={row.sku}
              onChange={(e) => props.onUpdateRow(row.key, { sku: e.target.value })}
              disabled={disabled}
              aria-label={`Clave del renglón ${globalIndex + 1}`}
            />
          ) : (
            <button
              type="button"
              className="rs-cell rs-clave"
              style={{ ...col(C.clave), ...fs(L.FONT_BODY) }}
              onClick={() => openSearch(globalIndex)}
              disabled={disabled}
              title="Clic para cambiar el producto"
            >
              {row.sku}
            </button>
          ))}

        <input
          className="rs-cell rs-input rs-center"
          style={{ ...col(C.cantidad), ...fs(L.FONT_BODY) }}
          inputMode="decimal"
          value={row.cantidad}
          onChange={(e) => props.onUpdateRow(row.key, { cantidad: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              openSearch(rows.length);
            }
          }}
          disabled={disabled}
          data-rs-field="cantidad"
          data-rs-index={globalIndex}
          aria-label={`Cantidad del renglón ${globalIndex + 1}`}
        />

        {externa && searching ? (
          renderSearch(localRow)
        ) : row.manual ? (
          <input
            className="rs-cell rs-input rs-producto"
            style={{ ...col(C.producto), ...fs(L.FONT_BODY), paddingLeft: productoPad }}
            value={row.productoNombre}
            onChange={(e) => props.onUpdateRow(row.key, { productoNombre: e.target.value })}
            placeholder="Nombre del producto"
            disabled={disabled}
            data-rs-field="producto"
            data-rs-index={globalIndex}
            aria-label={`Producto del renglón ${globalIndex + 1}`}
          />
        ) : externa ? (
          <button
            type="button"
            className="rs-cell rs-clave rs-left rs-producto"
            style={{ ...col(C.producto), ...fs(L.FONT_BODY), paddingLeft: productoPad }}
            onClick={() => openSearch(globalIndex)}
            disabled={disabled}
            title="Clic para cambiar el producto"
          >
            {row.productoNombre}
          </button>
        ) : (
          <div
            className="rs-cell rs-text rs-producto"
            style={{ ...col(C.producto), ...fs(L.FONT_BODY), paddingLeft: productoPad }}
            title={row.productoNombre}
          >
            {row.productoNombre}
          </div>
        )}

        <input
          className="rs-cell rs-input rs-right"
          style={{ ...col(C.precio), ...fs(L.FONT_BODY), paddingRight: pctX(C.precio[1] - C.precioTextRight) }}
          inputMode="decimal"
          value={row.precioUnitario}
          onChange={(e) => props.onUpdateRow(row.key, { precioUnitario: e.target.value })}
          disabled={disabled}
          aria-label={`Precio del renglón ${globalIndex + 1}`}
        />

        <div
          className="rs-cell rs-text rs-right"
          style={{ ...col(C.importe), ...fs(L.FONT_BODY), paddingRight: pctX(C.importe[1] - C.importeTextRight) }}
        >
          {formatMoney(importe)}
        </div>

        <button
          type="button"
          className="rs-remove icon-btn icon-btn-remove"
          onClick={() => props.onRemoveRow(row.key)}
          disabled={disabled}
          title="Eliminar renglón"
          aria-label={`Eliminar renglón ${globalIndex + 1}`}
        >
          <img src={basuraIcon} alt="" aria-hidden="true" />
        </button>
      </div>
    );
  }

  function renderSheet(sheet: number) {
    const isFirst = sheet === 0;
    const isLast = sheet === sheetCount - 1;
    const t = props.totales;
    return (
      <div className="rs-sheet" key={sheet}>
        <div className="rs-page">
          <img className="rs-bg" src={externa ? templateExternaUrl : templateUrl} alt="" draggable={false} />

          <div className="rs-cover" style={box(...L.FOLIO.erase)} />
          <div className="rs-cover" style={box(...L.FECHA.erase)} />
          {!externa && <div className="rs-cover" style={box(...L.PEDIDO.erase)} />}

          <div
            className="rs-static rs-folio-auto"
            style={{ ...centered(L.FOLIO.cx, L.FOLIO.cy, L.FOLIO.maxWidth, 12), ...fs(9) }}
            title="El folio se asigna automáticamente al generar la remisión"
          >
            Automático
          </div>
          <div
            className="rs-static"
            style={{ ...centered(L.FECHA.cx, L.FECHA.cy, 100, 12), ...fs(L.FONT_HEADER_FIELD) }}
            title="La fecha se asigna automáticamente"
          >
            {L.formatFechaHoja(props.fecha)}
          </div>

          {externa ? (
            L.CLIENTE_BLOCK.fields.map(({ campo, label }, i) => {
              const cy = L.CLIENTE_BLOCK.firstCy + i * L.CLIENTE_BLOCK.pitch;
              const value = campo === "cliente" ? props.pedido : props.cliente[campo];
              const size = fitSize(value, L.CLIENTE_BLOCK.valueMaxWidth, L.FONT_BODY, 6);
              const valueStyle = {
                ...box(L.CLIENTE_BLOCK.valueX, cy - 6, L.CLIENTE_BLOCK.valueMaxWidth, 12),
                fontSize: `max(10px, calc(var(--u) * ${size}))`,
              };
              return (
                <Fragment key={campo}>
                  <div
                    className="rs-static rs-left rs-bold"
                    style={{ ...box(L.CLIENTE_BLOCK.labelX, cy - 6, L.CLIENTE_BLOCK.valueX - L.CLIENTE_BLOCK.labelX, 12), ...fs(L.FONT_BODY) }}
                  >
                    {label}
                  </div>
                  {isFirst ? (
                    <input
                      className="rs-input rs-field"
                      style={valueStyle}
                      value={value}
                      onChange={(e) =>
                        campo === "cliente" ? props.onPedidoChange(e.target.value) : props.onClienteChange(campo, e.target.value)
                      }
                      disabled={disabled}
                      aria-label={label.replace(":", "")}
                    />
                  ) : (
                    <div className="rs-static rs-left" style={valueStyle}>
                      {value}
                    </div>
                  )}
                </Fragment>
              );
            })
          ) : isFirst ? (
            <input
              className="rs-input rs-center rs-pedido"
              style={{
                ...centered(L.PEDIDO.cx, L.PEDIDO.cy, L.PEDIDO.erase[2], 13),
                fontSize: `max(10px, calc(var(--u) * ${pedidoSize}))`,
              }}
              value={props.pedido}
              onChange={(e) => props.onPedidoChange(e.target.value)}
              placeholder="Ej. JALISCO"
              disabled={disabled}
              aria-label="Pedido bodegas"
            />
          ) : (
            <div
              className="rs-static"
              style={{
                ...centered(L.PEDIDO.cx, L.PEDIDO.cy, L.PEDIDO.erase[2], 13),
                fontSize: `max(10px, calc(var(--u) * ${pedidoSize}))`,
              }}
            >
              {props.pedido || "—"}
            </div>
          )}

          {Array.from({ length: L.ROWS_PER_PAGE }, (_, local) => renderRow(sheet * L.ROWS_PER_PAGE + local, local))}

          {isLast && (
            <>
              <div
                className="rs-static rs-precio-texto"
                style={{ ...box(L.PRECIO_TEXTO.x, L.PRECIO_TEXTO.y, L.PRECIO_TEXTO.w, L.PRECIO_TEXTO.h), ...fs(9), lineHeight: `calc(var(--u) * ${L.PRECIO_TEXTO.lineHeight})` }}
              >
                {t.precioTexto}
              </div>

              <div className="rs-static rs-right" style={{ ...totalBox(L.TOTAL_CY.subtotal), ...fs(L.FONT_TOTALES) }}>
                {formatMoney(t.subtotal)}
              </div>
              <div className="rs-totales-pct" style={{ ...totalBox(L.TOTAL_CY.descuentoPct), ...fs(L.FONT_TOTALES) }}>
                <input
                  className="rs-input rs-right"
                  value={props.descuentoPct}
                  onChange={(e) => props.onDescuentoChange(e.target.value)}
                  inputMode="decimal"
                  disabled={disabled}
                  aria-label="Descuento %"
                />
                <span>%</span>
              </div>
              <div className="rs-static rs-right" style={{ ...totalBox(L.TOTAL_CY.descuento), ...fs(L.FONT_TOTALES) }}>
                {formatMoney(t.descuento)}
              </div>
              <div className="rs-static rs-right" style={{ ...totalBox(L.TOTAL_CY.iva), ...fs(L.FONT_TOTALES) }}>
                {formatMoney(t.iva)}
              </div>
              <div className="rs-static rs-right rs-bold" style={{ ...totalBox(L.TOTAL_CY.total), ...fs(L.FONT_TOTALES) }}>
                {formatMoney(t.total)}
              </div>
            </>
          )}
        </div>
        {sheetCount > 1 && (
          <p className="hint rs-page-number">
            Hoja {sheet + 1} de {sheetCount}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="rs-wrap" ref={rootRef}>
      {Array.from({ length: sheetCount }, (_, i) => renderSheet(i))}
    </div>
  );
}

function totalBox(cy: number): CSSProperties {
  return { left: pctX(L.TOTALES_RIGHT - 70), top: pctY(cy - 6), width: pctX(70), height: pctY(12) };
}
