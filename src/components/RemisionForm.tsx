import { useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import {
  allowFsPath,
  computeRemisionMontos,
  createRemisionConFolio,
  getPrecio,
  getPreciosBySkuPrincipal,
  logEventAsActor,
  upsertPrecio,
} from "../db";
import { buildRemisionPdf } from "../pdf";
import { formatMoney } from "../excelExport";
import { numeroATextoMoneda } from "../numeroALetras";
import { computeSkuPrincipal, parseAmount } from "../precios";
import { fechaLocalDeHoy } from "../folios";
import { useAuth } from "../auth";
import type {
  Precio,
  RemisionConRenglones,
  RemisionInput,
  RemisionRenglonInput,
  TipoPrecio,
  TipoRemision,
} from "../types";
import type { Actor } from "../db";
import Toast from "./Toast";
import RemisionSheet from "./RemisionSheet";
import type { ClienteExterno, RenglonDraft } from "./RemisionSheet";

interface Props {
  tipo: TipoRemision;
  onCreated: () => void;
}

// Valor por default del campo Bodega — la mayoría de las remisiones son para
// Jalisco, pero el campo es editable (ver pedidoBodegas más abajo).
const PEDIDO_BODEGAS_DEFAULT = "JALISCO";

// En remisiones externas el mismo campo (pedido_bodegas) es el cliente, que
// no tiene un valor por default razonable.
function pedidoDefault(tipo: TipoRemision): string {
  return tipo === "externa" ? "" : PEDIDO_BODEGAS_DEFAULT;
}

export default function RemisionForm({ tipo, onCreated }: Props) {
  const { user, token } = useAuth();
  const etiquetaPedido = tipo === "externa" ? "Cliente" : "Bodega";
  const [pedidoBodegas, setPedidoBodegas] = useState(pedidoDefault(tipo));
  const [cliente, setCliente] = useState<ClienteExterno>({ rfc: "", direccion: "", contacto: "", telefono: "" });
  const [descuentoPct, setDescuentoPct] = useState("0");
  const [rows, setRows] = useState<RenglonDraft[]>([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const nextKey = useRef(0);

  const [guardarProductoKey, setGuardarProductoKey] = useState<number | null>(null);
  const [guardarProductoError, setGuardarProductoError] = useState<string | null>(null);
  const [guardarProductoSaving, setGuardarProductoSaving] = useState(false);
  const [guardarProductoTipo, setGuardarProductoTipo] = useState<TipoPrecio | null>(null);
  const [guardarProductoDuplicado, setGuardarProductoDuplicado] = useState<Precio | null>(null);
  const [productosGuardados, setProductosGuardados] = useState<Set<number>>(new Set());

  // Busca el precio exacto del SKU y, si no hay, cae al SKU principal (ej.
  // "8059" cuando el precio quedó guardado bajo "8059C") — mismo agrupamiento
  // que ya usa PreciosModal, para no dejar en blanco un precio que sí existe.
  async function lookupPrecioParaSku(actor: Actor, sku: string): Promise<string> {
    const exacto = await getPrecio(actor, sku);
    if (exacto) return String(exacto.precio);
    const relacionados = await getPreciosBySkuPrincipal(actor, computeSkuPrincipal(sku));
    return relacionados[0] ? String(relacionados[0].precio) : "";
  }

  function handlePickPrecio(index: number, precio: Precio) {
    const key = nextKey.current++;
    setRows((prev) =>
      index < prev.length
        ? prev.map((r, i) =>
            i === index
              ? { ...r, sku: precio.sku, productoNombre: precio.nombre, precioUnitario: String(precio.precio), manual: false }
              : r,
          )
        : [
            ...prev,
            {
              key,
              sku: precio.sku,
              productoNombre: precio.nombre,
              cantidad: "1",
              precioUnitario: String(precio.precio),
              manual: false,
            },
          ],
    );
  }

  // En internas `texto` es el SKU del producto manual; en externas (sin columna
  // Clave) es el nombre, y el renglón queda sin SKU.
  async function handleAddManual(index: number, texto: string) {
    if (!user || !token) return;
    const sku = tipo === "externa" ? "" : texto;
    const productoNombre = tipo === "externa" ? texto : "";
    const precioUnitario = sku ? await lookupPrecioParaSku({ id: user.id, token }, sku) : "";
    const key = nextKey.current++;
    setRows((prev) =>
      index < prev.length
        ? prev.map((r, i) =>
            i === index ? { ...r, sku, productoNombre, precioUnitario, manual: true } : r,
          )
        : [...prev, { key, sku, productoNombre, cantidad: "1", precioUnitario, manual: true }],
    );
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
      const existing = await getPrecio(actor, row.sku.trim());
      if (existing) {
        setGuardarProductoTipo(tipo);
        setGuardarProductoDuplicado(existing);
        return;
      }
      await upsertPrecio(actor, {
        sku: row.sku.trim(),
        nombre: row.productoNombre.trim(),
        precio: precioNum,
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

  function updateRow(key: number, patch: Partial<RenglonDraft>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function removeRow(key: number) {
    setRows((prev) => prev.filter((r) => r.key !== key));
  }

  const parsedRows = useMemo(
    () =>
      rows.map((r) => {
        const cantidadNum = parseAmount(r.cantidad);
        const precioNum = parseAmount(r.precioUnitario);
        return {
          ...r,
          // null (vacío o no numérico) se muestra como 0 en la vista previa,
          // pero handleGenerar() revalida cantidad (> 0) y precio (parseAmount
          // sobre el string crudo, no sobre este 0 de relleno) más abajo — un
          // campo vacío o con basura ("12abc") nunca pasa como válido solo
          // porque acá se ve en 0, aunque precio 0 explícito sí es válido.
          cantidadNum: cantidadNum ?? 0,
          precioNum: precioNum ?? 0,
        };
      }),
    [rows],
  );

  const descuentoPctNum = useMemo(() => parseAmount(descuentoPct) ?? 0, [descuentoPct]);
  const { subtotal, descuento, iva, total } = useMemo(
    () => computeRemisionMontos(parsedRows.map((r) => ({ cantidad: r.cantidadNum, precio_unitario: r.precioNum })), descuentoPctNum),
    [parsedRows, descuentoPctNum],
  );
  const precioTexto = numeroATextoMoneda(total);

  function resetForm() {
    setRows([]);
    setDescuentoPct("0");
    setPedidoBodegas(pedidoDefault(tipo));
    setCliente({ rfc: "", direccion: "", contacto: "", telefono: "" });
  }

  async function handleGenerar() {
    setError(null);
    if (!user || !token) return;
    const actor = { id: user.id, token };
    if (!pedidoBodegas.trim()) {
      setError(`El campo ${etiquetaPedido} es obligatorio.`);
      return;
    }
    if (parsedRows.length === 0) {
      setError("Agrega al menos un producto.");
      return;
    }
    for (const r of parsedRows) {
      if (r.manual && ((tipo !== "externa" && !r.sku.trim()) || !r.productoNombre.trim())) {
        setError(
          tipo === "externa"
            ? "Escribe el nombre de los productos agregados manualmente."
            : "Completa la clave y el nombre de los productos agregados manualmente.",
        );
        return;
      }
      if (!(r.cantidadNum > 0)) {
        setError(`Cantidad inválida en el renglón de ${r.sku || "producto sin SKU"}.`);
        return;
      }
      // precio 0 es válido (producto sin costo/cortesía), pero un campo
      // vacío o con basura ("12abc") no debe colarse como 0 — se revalida
      // sobre el string crudo en vez de r.precioNum, que ya normalizó null a 0.
      const precioParsed = parseAmount(r.precioUnitario);
      if (precioParsed === null || precioParsed < 0) {
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
      const remisionInput: Omit<
        RemisionInput,
        "folio" | "subtotal" | "descuento" | "iva" | "total" | "precio_texto"
      > = {
        fecha,
        tipo,
        pedido_bodegas: pedidoBodegas.trim(),
        ...(tipo === "externa"
          ? {
              cliente_rfc: cliente.rfc,
              cliente_direccion: cliente.direccion,
              cliente_contacto: cliente.contacto,
              cliente_telefono: cliente.telefono,
            }
          : {}),
        descuento_pct: descuentoPctNum,
      };
      created = await createRemisionConFolio(actor, remisionInput.pedido_bodegas, remisionInput, renglonesInput);
    } catch (err) {
      setError(`No se pudo generar la remisión: ${String(err)}`);
      setGenerating(false);
      return;
    }

    logEventAsActor(actor, "INFO", `Remisión ${created.folio} generada — total ${formatMoney(created.total)}`);
    setToastMessage(`${created.folio} generada`);
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
      logEventAsActor(
        actor,
        "ERROR",
        `Remisión ${created.folio} guardada, pero no se pudo generar/guardar su PDF: ${String(err)}`,
      );
      setError(
        `La remisión ${created.folio} se guardó correctamente, pero no se pudo generar o guardar el PDF. Puedes intentarlo de nuevo más tarde.`,
      );
    } finally {
      setGenerating(false);
    }
  }

  const manualRows = parsedRows.filter((r) => r.manual && r.sku.trim() && r.productoNombre.trim());

  return (
    <div className="remision-form">
      <RemisionSheet
        tipo={tipo}
        fecha={fechaLocalDeHoy()}
        pedido={pedidoBodegas}
        onPedidoChange={setPedidoBodegas}
        cliente={cliente}
        onClienteChange={(campo, value) => setCliente((prev) => ({ ...prev, [campo]: value }))}
        rows={parsedRows}
        descuentoPct={descuentoPct}
        onDescuentoChange={setDescuentoPct}
        totales={{ subtotal, descuento, iva, total, precioTexto }}
        disabled={generating}
        onUpdateRow={updateRow}
        onRemoveRow={removeRow}
        onPickPrecio={handlePickPrecio}
        onAddManual={handleAddManual}
      />

      {manualRows.length > 0 && (
        <div className="remision-manual-entry">
          <p className="hint" style={{ margin: 0 }}>
            Productos agregados manualmente (no están en el catálogo). Guárdalos para que aparezcan en la búsqueda la
            próxima vez.
          </p>
          {manualRows.map((r) => (
            <div key={r.key}>
              <div className="form-row" style={{ alignItems: "center" }}>
                <span>
                  <span className="product-card-code">#{r.sku}</span> {r.productoNombre} — {formatMoney(r.precioNum)}
                </span>
                {productosGuardados.has(r.key) ? (
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
                )}
              </div>
              {guardarProductoKey === r.key && (
                <div>
                  {guardarProductoDuplicado ? (
                    <span className="confirm-delete">
                      El SKU {guardarProductoDuplicado.sku} ya existe ({guardarProductoDuplicado.nombre} —{" "}
                      {formatMoney(guardarProductoDuplicado.precio)}). ¿Actualizarlo con estos datos?
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
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {error && <p className="form-error">{error}</p>}

      <div className="form-actions remision-generar">
        <button type="button" className="btn btn-primary" onClick={handleGenerar} disabled={generating}>
          {generating ? "Generando…" : "Generar remisión"}
        </button>
      </div>

      <Toast message={toastMessage ?? ""} show={!!toastMessage} onHide={() => setToastMessage(null)} />
    </div>
  );
}
