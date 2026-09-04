import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import {
  allowFsPath,
  createRemisionConFolio,
  getPrecio,
  getPreciosBySkuPrincipal,
  logEvent,
  searchPrecios,
  upsertPrecio,
} from "../db";
import { buildRemisionPdf } from "../pdf";
import { formatMoney } from "../excelExport";
import { numeroATextoMoneda } from "../numeroALetras";
import { computeSkuPrincipal } from "../precios";
import { fechaLocalDeHoy } from "../folios";
import { useAuth } from "../auth";
import type { Precio, RemisionConRenglones, RemisionInput, RemisionRenglonInput, TipoPrecio } from "../types";
import basuraIcon from "../../Assets/basura.svg";

interface Props {
  onCreated: () => void;
}

interface RenglonDraft {
  key: number;
  sku: string;
  productoNombre: string;
  cantidad: string;
  precioUnitario: string;
  // Solo true para renglones agregados por "Agregarlo manualmente" — son los
  // únicos candidatos a "Guardar producto" (los de búsqueda ya existen en
  // `precios`, ver handleSelectPrecio).
  manual: boolean;
}

const IVA_RATE = 0.16;
// Valor por default del campo Bodega — la mayoría de las remisiones internas
// son para Jalisco, pero el campo es editable (ver pedidoBodegas más abajo).
const PEDIDO_BODEGAS_INTERNA = "JALISCO";

export default function RemisionForm({ onCreated }: Props) {
  const { user, token } = useAuth();
  const [pedidoBodegas, setPedidoBodegas] = useState(PEDIDO_BODEGAS_INTERNA);
  const [descuentoPct, setDescuentoPct] = useState("0");
  const [rows, setRows] = useState<RenglonDraft[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Precio[]>([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultado, setResultado] = useState<RemisionConRenglones | null>(null);
  const [manualEntryOpen, setManualEntryOpen] = useState(false);
  const [manualSku, setManualSku] = useState("");
  const [manualNombre, setManualNombre] = useState("");
  const nextKey = useRef(0);

  const [guardarProductoKey, setGuardarProductoKey] = useState<number | null>(null);
  const [guardarProductoError, setGuardarProductoError] = useState<string | null>(null);
  const [guardarProductoSaving, setGuardarProductoSaving] = useState(false);
  const [guardarProductoTipo, setGuardarProductoTipo] = useState<TipoPrecio | null>(null);
  const [guardarProductoDuplicado, setGuardarProductoDuplicado] = useState<Precio | null>(null);
  const [productosGuardados, setProductosGuardados] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const precios = await searchPrecios(query);
      if (!cancelled) setResults(precios.slice(0, 8));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  // Busca el precio exacto del SKU y, si no hay, cae al SKU principal (ej.
  // "8059" cuando el precio quedó guardado bajo "8059C") — mismo agrupamiento
  // que ya usa PreciosModal, para no dejar en blanco un precio que sí existe.
  async function lookupPrecioParaSku(sku: string): Promise<string> {
    const exacto = await getPrecio(sku);
    if (exacto) return String(exacto.precio);
    const relacionados = await getPreciosBySkuPrincipal(computeSkuPrincipal(sku));
    return relacionados[0] ? String(relacionados[0].precio) : "";
  }

  function handleSelectPrecio(precio: Precio) {
    setQuery("");
    setResults([]);
    setRows((prev) => [
      ...prev,
      {
        key: nextKey.current++,
        sku: precio.sku,
        productoNombre: precio.nombre,
        cantidad: "1",
        precioUnitario: String(precio.precio),
        manual: false,
      },
    ]);
  }

  async function handleAddManual() {
    const sku = manualSku.trim();
    const productoNombre = manualNombre.trim();
    if (!sku || !productoNombre) return;
    const precioUnitario = await lookupPrecioParaSku(sku);
    setRows((prev) => [
      ...prev,
      { key: nextKey.current++, sku, productoNombre, cantidad: "1", precioUnitario, manual: true },
    ]);
    setManualSku("");
    setManualNombre("");
  }

  function resetGuardarProducto() {
    setGuardarProductoKey(null);
    setGuardarProductoError(null);
    setGuardarProductoTipo(null);
    setGuardarProductoDuplicado(null);
  }

  // Mismo criterio de duplicado que PreciosModal: SKU exacto, no sku_principal
  // (una variante con letra es un producto relacionado válido, no un
  // duplicado del SKU base).
  async function handleGuardarProducto(row: RenglonDraft, precioNum: number, tipo: TipoPrecio) {
    if (!row.sku.trim() || !row.productoNombre.trim()) return;
    if (!(precioNum >= 0)) {
      setGuardarProductoError("Ingresa un precio válido (mayor o igual a 0) antes de guardar el producto.");
      return;
    }
    if (!user || !token) return;
    const actor = { id: user.id, token };
    setGuardarProductoSaving(true);
    setGuardarProductoError(null);
    try {
      const existing = await getPrecio(row.sku.trim());
      if (existing) {
        setGuardarProductoTipo(tipo);
        setGuardarProductoDuplicado(existing);
        return;
      }
      await upsertPrecio(actor, {
        sku: row.sku.trim(),
        nombre: row.productoNombre.trim(),
        precio: precioNum,
        usuario: user?.username ?? null,
        tipo,
      });
      setProductosGuardados((prev) => new Set(prev).add(row.key));
      resetGuardarProducto();
    } catch (err) {
      setGuardarProductoError(`No se pudo guardar el producto: ${String(err)}`);
    } finally {
      setGuardarProductoSaving(false);
    }
  }

  async function handleConfirmarActualizarProducto(row: RenglonDraft, precioNum: number) {
    if (!guardarProductoTipo || !user || !token) return;
    const actor = { id: user.id, token };
    setGuardarProductoSaving(true);
    try {
      await upsertPrecio(actor, {
        sku: row.sku.trim(),
        nombre: row.productoNombre.trim(),
        precio: precioNum,
        usuario: user?.username ?? null,
        tipo: guardarProductoTipo,
      });
      setProductosGuardados((prev) => new Set(prev).add(row.key));
      resetGuardarProducto();
    } catch (err) {
      setGuardarProductoError(`No se pudo actualizar el producto: ${String(err)}`);
    } finally {
      setGuardarProductoSaving(false);
    }
  }

  function updateRow(key: number, field: "cantidad" | "precioUnitario", value: string) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  }

  function removeRow(key: number) {
    setRows((prev) => prev.filter((r) => r.key !== key));
  }

  const parsedRows = useMemo(
    () =>
      rows.map((r) => {
        const cantidadNum = parseFloat(r.cantidad.replace(",", "."));
        const precioNum = parseFloat(r.precioUnitario.replace(",", "."));
        return {
          ...r,
          cantidadNum: Number.isFinite(cantidadNum) ? cantidadNum : 0,
          precioNum: Number.isFinite(precioNum) ? precioNum : 0,
        };
      }),
    [rows],
  );

  const subtotal = useMemo(
    () => parsedRows.reduce((sum, r) => sum + r.cantidadNum * r.precioNum, 0),
    [parsedRows],
  );
  const descuentoPctNum = useMemo(() => {
    const n = parseFloat(descuentoPct.replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  }, [descuentoPct]);
  const descuento = subtotal * (descuentoPctNum / 100);
  const iva = subtotal * IVA_RATE;
  const total = subtotal - descuento - iva;
  const precioTexto = numeroATextoMoneda(total);

  function resetForm() {
    setRows([]);
    setDescuentoPct("0");
    setPedidoBodegas(PEDIDO_BODEGAS_INTERNA);
  }

  async function handleGenerar() {
    setError(null);
    if (!user || !token) return;
    const actor = { id: user.id, token };
    if (!pedidoBodegas.trim()) {
      setError("El campo Bodega es obligatorio.");
      return;
    }
    if (parsedRows.length === 0) {
      setError("Agrega al menos un producto.");
      return;
    }
    for (const r of parsedRows) {
      if (!(r.cantidadNum > 0)) {
        setError(`Cantidad inválida en el renglón de ${r.sku || "producto sin SKU"}.`);
        return;
      }
      if (!(r.precioNum > 0)) {
        setError(`Precio inválido en el renglón de ${r.sku || "producto sin SKU"}.`);
        return;
      }
    }
    if (!(descuentoPctNum >= 0) || descuentoPctNum > 100) {
      setError("El descuento % debe estar entre 0 y 100.");
      return;
    }
    if (total < 0) {
      setError("El total no puede quedar negativo — revisa el descuento.");
      return;
    }

    setGenerating(true);

    // Punto de no retorno: una vez que createRemision() resuelve, el
    // documento ya quedó guardado en la BD con el folio consumido. Un fallo
    // posterior al armar/guardar el PDF NO debe reportarse como "no se
    // generó la remisión" — el usuario reintentaría y quemaría un folio de
    // más sobre un documento que ya existe.
    let created: RemisionConRenglones;
    try {
      const fecha = fechaLocalDeHoy();
      const renglonesInput: RemisionRenglonInput[] = parsedRows.map((r) => ({
        sku: r.sku,
        producto_nombre: r.productoNombre,
        cantidad: r.cantidadNum,
        precio_unitario: r.precioNum,
        importe: r.cantidadNum * r.precioNum,
      }));
      const remisionInput: Omit<RemisionInput, "folio"> = {
        fecha,
        tipo: "interna",
        pedido_bodegas: pedidoBodegas.trim(),
        subtotal,
        descuento_pct: descuentoPctNum,
        descuento,
        iva,
        total,
        precio_texto: precioTexto,
        usuario: user?.username ?? null,
      };
      created = await createRemisionConFolio(actor, parsedRows[0].sku || "GRAL", remisionInput, renglonesInput);
    } catch (err) {
      setError(`No se pudo generar la remisión: ${String(err)}`);
      setGenerating(false);
      return;
    }

    logEvent(
      "INFO",
      `Remisión ${created.folio} generada — total ${formatMoney(created.total)}`,
      user?.username ?? null,
    );
    setResultado(created);
    resetForm();
    onCreated();

    try {
      const pdfBytes = await buildRemisionPdf(created, created.renglones);
      const path = await save({
        title: "Guardar remisión",
        defaultPath: `${created.folio}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (path) {
        await allowFsPath(path);
        await writeFile(path, pdfBytes);
      }
    } catch (err) {
      logEvent(
        "ERROR",
        `Remisión ${created.folio} guardada, pero no se pudo generar/guardar su PDF: ${String(err)}`,
        user?.username ?? null,
      );
      setError(
        `La remisión ${created.folio} se guardó correctamente, pero no se pudo generar o guardar el PDF. Puedes intentarlo de nuevo más tarde.`,
      );
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="remision-form">
      {resultado && (
        <div className="import-review-summary" style={{ marginBottom: "0.8rem" }}>
          <span className="tag">Remisión {resultado.folio} generada — total {formatMoney(resultado.total)}</span>
          <button type="button" className="btn-link" onClick={() => setResultado(null)}>
            Cerrar
          </button>
        </div>
      )}

      <div className="form-row">
        <label>
          Bodega
          <input
            type="text"
            value={pedidoBodegas}
            onChange={(e) => setPedidoBodegas(e.target.value)}
            disabled={generating}
          />
        </label>
      </div>

      <div className="remision-search" style={{ position: "relative" }}>
        <label>
          Buscar por SKU (normal o con letra, ej. 7078E) o nombre
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ej. 8059, 7078E o tangram"
            disabled={generating}
          />
        </label>
        {results.length > 0 && (
          <ul className="remision-search-results">
            {results.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => handleSelectPrecio(p)}>
                  <span className="product-card-code">#{p.sku}</span> {p.nombre} —{" "}
                  {formatMoney(p.precio)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {!manualEntryOpen ? (
        <button
          type="button"
          className="btn-link"
          onClick={() => {
            setManualSku(query.trim());
            setManualEntryOpen(true);
          }}
          disabled={generating}
        >
          ¿No aparece en el catálogo? Agregarlo manualmente
        </button>
      ) : (
        <div className="remision-manual-entry">
          <div className="form-row">
            <label>
              SKU
              <input
                type="text"
                value={manualSku}
                onChange={(e) => setManualSku(e.target.value)}
                disabled={generating}
                autoFocus
              />
            </label>
            <label>
              Producto
              <input
                type="text"
                value={manualNombre}
                onChange={(e) => setManualNombre(e.target.value)}
                disabled={generating}
              />
            </label>
          </div>
          <p className="hint" style={{ margin: 0 }}>
            No está en el catálogo de fichas técnicas — se agrega igual como renglón para que quien
            surta la remisión pueda incluirlo. El precio se rellena solo si ya existe uno guardado
            para este SKU; si no, queda editable en la tabla.
          </p>
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleAddManual}
              disabled={generating || !manualSku.trim() || !manualNombre.trim()}
            >
              Agregar renglón
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setManualEntryOpen(false);
                setManualSku("");
                setManualNombre("");
              }}
              disabled={generating}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {parsedRows.length > 0 && (
        <div className="import-review-table-wrap">
          <table className="import-review-table">
            <thead>
              <tr>
                <th>Clave</th>
                <th>Producto</th>
                <th>Cantidad</th>
                <th>Precio</th>
                <th>Importe</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {parsedRows.map((r) => (
                <Fragment key={r.key}>
                <tr>
                  <td>{r.sku}</td>
                  <td>{r.productoNombre}</td>
                  <td>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={r.cantidad}
                      onChange={(e) => updateRow(r.key, "cantidad", e.target.value)}
                      disabled={generating}
                      style={{ width: "4rem" }}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={r.precioUnitario}
                      onChange={(e) => updateRow(r.key, "precioUnitario", e.target.value)}
                      disabled={generating}
                      style={{ width: "6rem" }}
                    />
                  </td>
                  <td>{formatMoney(r.cantidadNum * r.precioNum)}</td>
                  <td>
                    {r.manual &&
                      (productosGuardados.has(r.key) ? (
                        <span className="hint">Guardado</span>
                      ) : (
                        guardarProductoKey !== r.key && (
                          <button
                            type="button"
                            className="btn-link"
                            onClick={() => {
                              resetGuardarProducto();
                              setGuardarProductoKey(r.key);
                            }}
                            disabled={generating}
                          >
                            Guardar producto
                          </button>
                        )
                      ))}
                    <button
                      type="button"
                      className="icon-btn icon-btn-remove"
                      onClick={() => removeRow(r.key)}
                      disabled={generating}
                      title="Eliminar renglón"
                      aria-label="Eliminar renglón"
                    >
                      <img src={basuraIcon} alt="" aria-hidden="true" />
                    </button>
                  </td>
                </tr>
                {guardarProductoKey === r.key && (
                  <tr>
                    <td colSpan={6}>
                      {guardarProductoDuplicado ? (
                        <span className="confirm-delete">
                          El SKU {guardarProductoDuplicado.sku} ya existe (
                          {guardarProductoDuplicado.nombre} — {formatMoney(guardarProductoDuplicado.precio)}
                          ). ¿Actualizarlo con estos datos?
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => handleConfirmarActualizarProducto(r, r.precioNum)}
                            disabled={guardarProductoSaving}
                          >
                            Actualizar
                          </button>
                          <button
                            type="button"
                            className="btn-link"
                            onClick={resetGuardarProducto}
                            disabled={guardarProductoSaving}
                          >
                            Cancelar
                          </button>
                        </span>
                      ) : (
                        <span className="confirm-delete">
                          ¿Este producto es interno o externo?
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => handleGuardarProducto(r, r.precioNum, "interno")}
                            disabled={guardarProductoSaving}
                          >
                            Interno
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => handleGuardarProducto(r, r.precioNum, "externo")}
                            disabled={guardarProductoSaving}
                          >
                            Externo
                          </button>
                          <button
                            type="button"
                            className="btn-link"
                            onClick={resetGuardarProducto}
                            disabled={guardarProductoSaving}
                          >
                            Cancelar
                          </button>
                        </span>
                      )}
                      {guardarProductoError && <p className="form-error">{guardarProductoError}</p>}
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="remision-totales">
        <div className="form-row">
          <span>Subtotal</span>
          <strong>{formatMoney(subtotal)}</strong>
        </div>
        <div className="form-row">
          <label>
            Descuento %
            <input
              type="text"
              inputMode="decimal"
              value={descuentoPct}
              onChange={(e) => setDescuentoPct(e.target.value)}
              disabled={generating}
              style={{ width: "4rem" }}
            />
          </label>
          <strong>{formatMoney(descuento)}</strong>
        </div>
        <div className="form-row">
          <span>IVA 16%</span>
          <strong>{formatMoney(iva)}</strong>
        </div>
        <div className="form-row">
          <span>Total</span>
          <strong>{formatMoney(total)}</strong>
        </div>
        <p className="hint">Precio en texto: {precioTexto}</p>
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="form-actions">
        <button type="button" className="btn btn-primary" onClick={handleGenerar} disabled={generating}>
          {generating ? "Generando…" : "Generar remisión"}
        </button>
      </div>
    </div>
  );
}
