import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import {
  getPrecio,
  getPreciosBySkuPrincipal,
  getRemisionRenglones,
  logEvent,
  searchPrecios,
  updateRemisionConRenglones,
} from "../db";
import { buildRemisionPdf } from "../pdf";
import { formatMoney } from "../excelExport";
import { numeroATextoMoneda } from "../numeroALetras";
import { computeSkuPrincipal } from "../precios";
import { hasPermission, useAuth } from "../auth";
import type { Precio, Remision, RemisionRenglon, RemisionRenglonInput } from "../types";
import Toast from "./Toast";
import basuraIcon from "../../Assets/basura.svg";

interface Props {
  remision: Remision;
  onClose: () => void;
  onUpdated: () => void;
}

interface RenglonDraft {
  key: number;
  sku: string;
  productoNombre: string;
  cantidad: string;
  precioUnitario: string;
}

const IVA_RATE = 0.16;

function formatFechaCorta(fechaIso: string): string {
  const [y, m, d] = fechaIso.split("-");
  if (!y || !m || !d) return fechaIso;
  return `${d}/${m}/${y}`;
}

export default function RemisionDetalleModal({ remision, onClose, onUpdated }: Props) {
  const { user } = useAuth();
  const canEditar = hasPermission(user, "remisiones_crear");

  const [header, setHeader] = useState<Remision>(remision);
  const [renglones, setRenglones] = useState<RemisionRenglon[] | null>(null);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // --- Edición ---
  const [rows, setRows] = useState<RenglonDraft[]>([]);
  const [pedidoBodegas, setPedidoBodegas] = useState("");
  const [descuentoPct, setDescuentoPct] = useState("0");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Precio[]>([]);
  const [manualEntryOpen, setManualEntryOpen] = useState(false);
  const [manualSku, setManualSku] = useState("");
  const [manualNombre, setManualNombre] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextKey = useRef(0);

  // --- Guardar PDF (mismo folio) ---
  const [savingPdf, setSavingPdf] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await getRemisionRenglones(remision.id);
      if (!cancelled) setRenglones(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [remision.id]);

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

  async function lookupPrecioParaSku(sku: string): Promise<string> {
    const exacto = await getPrecio(sku);
    if (exacto) return String(exacto.precio);
    const relacionados = await getPreciosBySkuPrincipal(computeSkuPrincipal(sku));
    return relacionados[0] ? String(relacionados[0].precio) : "";
  }

  function handleEnterEdit() {
    if (!renglones) return;
    setRows(
      renglones.map((r) => ({
        key: nextKey.current++,
        sku: r.sku,
        productoNombre: r.producto_nombre,
        cantidad: String(r.cantidad),
        precioUnitario: String(r.precio_unitario),
      })),
    );
    setPedidoBodegas(header.pedido_bodegas);
    setDescuentoPct(String(header.descuento_pct));
    setError(null);
    setMode("edit");
  }

  function handleCancelEdit() {
    setMode("view");
    setError(null);
    setManualEntryOpen(false);
    setManualSku("");
    setManualNombre("");
    setQuery("");
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
      { key: nextKey.current++, sku, productoNombre, cantidad: "1", precioUnitario },
    ]);
    setManualSku("");
    setManualNombre("");
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

  async function handleGuardarEdicion() {
    setError(null);
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

    setSaving(true);
    try {
      const renglonesInput: RemisionRenglonInput[] = parsedRows.map((r) => ({
        sku: r.sku,
        producto_nombre: r.productoNombre,
        cantidad: r.cantidadNum,
        precio_unitario: r.precioNum,
        importe: r.cantidadNum * r.precioNum,
      }));
      const updated = await updateRemisionConRenglones(
        remision.id,
        {
          pedido_bodegas: pedidoBodegas.trim(),
          subtotal,
          descuento_pct: descuentoPctNum,
          descuento,
          iva,
          total,
          precio_texto: precioTexto,
        },
        renglonesInput,
      );
      setHeader(updated);
      setRenglones(updated.renglones);
      setMode("view");
      setToastMessage("Remisión actualizada.");
      logEvent("INFO", `Remisión ${updated.folio} editada`, user?.username ?? null);
      onUpdated();
    } catch (err) {
      setError(`No se pudo guardar la edición: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  // Re-genera el PDF con el estado actual de la remisión (folio sin cambios
  // — nunca se crea uno nuevo) para poder volver a guardarlo si se perdió el
  // archivo original o se acaba de editar la remisión.
  async function handleGuardarPdf() {
    if (!renglones) return;
    setSavingPdf(true);
    try {
      const pdfBytes = await buildRemisionPdf(header, renglones);
      const path = await save({
        title: "Guardar remisión",
        defaultPath: `${header.folio}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (path) {
        await writeFile(path, pdfBytes);
        setToastMessage("PDF guardado.");
      }
    } catch (err) {
      logEvent(
        "ERROR",
        `No se pudo generar/guardar el PDF de la remisión ${header.folio}: ${String(err)}`,
        user?.username ?? null,
      );
      setToastMessage("No se pudo guardar el PDF.");
    } finally {
      setSavingPdf(false);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        <h2>Remisión {header.folio}</h2>
        <p className="hint">
          {formatFechaCorta(header.fecha)} · Pedido: {header.pedido_bodegas || "—"} ·{" "}
          {header.cancelada ? "Cancelada" : "Activa"}
        </p>

        {mode === "view" ? (
          <>
            {renglones === null ? (
              <p className="hint">Cargando…</p>
            ) : (
              <div className="import-review-table-wrap">
                <table className="import-review-table">
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Producto</th>
                      <th>Cantidad</th>
                      <th>Precio</th>
                      <th>Importe</th>
                    </tr>
                  </thead>
                  <tbody>
                    {renglones.map((r) => (
                      <tr key={r.id}>
                        <td>{r.sku}</td>
                        <td>{r.producto_nombre}</td>
                        <td>{r.cantidad}</td>
                        <td>{formatMoney(r.precio_unitario)}</td>
                        <td>{formatMoney(r.importe)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="remision-totales">
              <div className="form-row">
                <span>Subtotal</span>
                <strong>{formatMoney(header.subtotal)}</strong>
              </div>
              <div className="form-row">
                <span>Descuento {header.descuento_pct}%</span>
                <strong>{formatMoney(header.descuento)}</strong>
              </div>
              <div className="form-row">
                <span>IVA 16%</span>
                <strong>{formatMoney(header.iva)}</strong>
              </div>
              <div className="form-row">
                <span>Total</span>
                <strong>{formatMoney(header.total)}</strong>
              </div>
              <p className="hint">Precio en texto: {header.precio_texto}</p>
            </div>

            <div className="form-actions">
              {canEditar && (
                <button type="button" className="btn btn-primary" onClick={handleEnterEdit} disabled={!renglones}>
                  Editar
                </button>
              )}
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleGuardarPdf}
                disabled={!renglones || savingPdf}
              >
                {savingPdf ? "Guardando…" : "Guardar PDF"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Cerrar
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="form-row">
              <label>
                Bodega
                <input
                  type="text"
                  value={pedidoBodegas}
                  onChange={(e) => setPedidoBodegas(e.target.value)}
                  disabled={saving}
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
                  disabled={saving}
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
                disabled={saving}
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
                      disabled={saving}
                      autoFocus
                    />
                  </label>
                  <label>
                    Producto
                    <input
                      type="text"
                      value={manualNombre}
                      onChange={(e) => setManualNombre(e.target.value)}
                      disabled={saving}
                    />
                  </label>
                </div>
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleAddManual}
                    disabled={saving || !manualSku.trim() || !manualNombre.trim()}
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
                    disabled={saving}
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
                              disabled={saving}
                              style={{ width: "4rem" }}
                            />
                          </td>
                          <td>
                            <input
                              type="text"
                              inputMode="decimal"
                              value={r.precioUnitario}
                              onChange={(e) => updateRow(r.key, "precioUnitario", e.target.value)}
                              disabled={saving}
                              style={{ width: "6rem" }}
                            />
                          </td>
                          <td>{formatMoney(r.cantidadNum * r.precioNum)}</td>
                          <td>
                            <button
                              type="button"
                              className="icon-btn icon-btn-remove"
                              onClick={() => removeRow(r.key)}
                              disabled={saving}
                              title="Eliminar renglón"
                              aria-label="Eliminar renglón"
                            >
                              <img src={basuraIcon} alt="" aria-hidden="true" />
                            </button>
                          </td>
                        </tr>
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
                    disabled={saving}
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
              <button type="button" className="btn btn-primary" onClick={handleGuardarEdicion} disabled={saving}>
                {saving ? "Guardando…" : "Guardar cambios"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={handleCancelEdit} disabled={saving}>
                Cancelar edición
              </button>
            </div>
          </>
        )}
      </div>

      <Toast message={toastMessage ?? ""} show={!!toastMessage} onHide={() => setToastMessage(null)} />
    </div>
  );
}
