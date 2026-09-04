import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import type { PlacasExistentes, PrintItem, PrintItemOrder, Product } from "../types";
import { buildOrderPdf } from "../pdf";
import type { OrderEntry } from "../pdf";
import { allowFsPath, createFolio, createPrintItemOrder, logEvent } from "../db";
import { useAuth } from "../auth";

const PLACAS_EXISTENTES_LABEL: Record<PlacasExistentes, string> = {
  "": "Sin definir",
  si: "Sí",
  no: "No",
};

interface Props {
  product: Product;
  items: PrintItem[];
  onOrderCreated: (printItemId: number, order: PrintItemOrder) => void;
  onSwitchToCompra: () => void;
}

interface ItemInputs {
  merma: string;
  cantidadArte: string;
  numeroTiros: string;
  formacionOverride: string;
  numeroPliegosOverride: string;
}

const NUMERIC_RE = /^\d+(\.\d+)?$/;

function isPureNumber(value: string): boolean {
  return NUMERIC_RE.test(value.trim());
}

function emptyInputs(): ItemInputs {
  return {
    merma: "",
    cantidadArte: "",
    numeroTiros: "",
    formacionOverride: "",
    numeroPliegosOverride: "",
  };
}

function computeTotal(
  item: PrintItem,
  inp: ItemInputs,
): { total: number; totalPorPliego: number } | null {
  const merma = parseFloat(inp.merma);
  const cantidadArte = parseFloat(inp.cantidadArte);
  const formacionNum = isPureNumber(item.formacion)
    ? parseFloat(item.formacion)
    : parseFloat(inp.formacionOverride);
  const pliegosNum = isPureNumber(item.numero_pliegos)
    ? parseFloat(item.numero_pliegos)
    : parseFloat(inp.numeroPliegosOverride);
  if (![merma, cantidadArte, formacionNum, pliegosNum].every(Number.isFinite)) return null;
  if (!(formacionNum > 0) || !(pliegosNum > 0)) return null;
  const total = Math.ceil((cantidadArte / formacionNum + merma) * pliegosNum);
  const totalPorPliego = Math.ceil(total / pliegosNum);
  return { total, totalPorPliego };
}

export default function ProduccionForm({ product, items, onOrderCreated, onSwitchToCompra }: Props) {
  const { user, token } = useAuth();
  const [inputs, setInputs] = useState<ItemInputs[]>(() => items.map(emptyInputs));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [generatedItems, setGeneratedItems] = useState<PrintItem[] | null>(null);

  function updateInput(index: number, key: keyof ItemInputs, value: string) {
    setInputs((prev) => prev.map((it, i) => (i === index ? { ...it, [key]: value } : it)));
  }

  async function handleGenerate() {
    setError(null);
    const entries: OrderEntry[] = [];
    const usedValues: { formacionNum: number; pliegosNum: number }[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const inp = inputs[i];

      if (!inp.merma.trim() || !isPureNumber(inp.merma)) {
        setError(`"${item.nombre || "Ítem " + (i + 1)}": ingresa una Merma numérica válida.`);
        return;
      }
      if (!inp.cantidadArte.trim() || !isPureNumber(inp.cantidadArte)) {
        setError(
          `"${item.nombre || "Ítem " + (i + 1)}": ingresa una Cantidad de arte numérica válida.`,
        );
        return;
      }
      if (!inp.numeroTiros.trim() || !isPureNumber(inp.numeroTiros)) {
        setError(
          `"${item.nombre || "Ítem " + (i + 1)}": ingresa un Número de tiros numérico válido.`,
        );
        return;
      }

      const formacionValida = isPureNumber(item.formacion);
      const formacionNum = formacionValida
        ? parseFloat(item.formacion)
        : parseFloat(inp.formacionOverride);
      if (!formacionValida && (!inp.formacionOverride.trim() || !isPureNumber(inp.formacionOverride))) {
        setError(
          `"${item.nombre || "Ítem " + (i + 1)}": la Formación registrada ("${item.formacion}") no es un número; ingresa el valor numérico a usar para el cálculo.`,
        );
        return;
      }
      if (!(formacionNum > 0)) {
        setError(`"${item.nombre || "Ítem " + (i + 1)}": la Formación debe ser mayor a 0.`);
        return;
      }

      const pliegosValidos = isPureNumber(item.numero_pliegos);
      const pliegosNum = pliegosValidos
        ? parseFloat(item.numero_pliegos)
        : parseFloat(inp.numeroPliegosOverride);
      if (
        !pliegosValidos &&
        (!inp.numeroPliegosOverride.trim() || !isPureNumber(inp.numeroPliegosOverride))
      ) {
        setError(
          `"${item.nombre || "Ítem " + (i + 1)}": el Número de pliegos registrado ("${item.numero_pliegos}") no es un número; ingresa el valor numérico a usar para el cálculo.`,
        );
        return;
      }
      if (!(pliegosNum > 0)) {
        setError(`"${item.nombre || "Ítem " + (i + 1)}": el Número de pliegos debe ser mayor a 0.`);
        return;
      }

      const merma = parseFloat(inp.merma);
      const cantidadArte = parseFloat(inp.cantidadArte);
      const numeroTiros = parseFloat(inp.numeroTiros);
      const totalPliegos = Math.ceil((cantidadArte / formacionNum + merma) * pliegosNum);
      const totalPorPliego = Math.ceil(totalPliegos / pliegosNum);

      entries.push({ item, merma, cantidadArte, numeroTiros, totalPliegos, totalPorPliego });
      usedValues.push({ formacionNum, pliegosNum });
    }

    if (!user || !token) return;
    const actor = { id: user.id, token };
    setSaving(true);
    try {
      const folio = await createFolio("produccion", product.codigo);
      const pdfBytes = await buildOrderPdf(product, entries, folio.folio);
      const defaultPath = `${folio.folio}.pdf`;

      const path = await save({
        title: "Guardar orden de impresión",
        defaultPath,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!path) {
        setSaving(false);
        return;
      }
      await allowFsPath(path);
      await writeFile(path, pdfBytes);

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!entry.item.id) continue;
        try {
          const order = await createPrintItemOrder(
            actor,
            entry.item.id,
            {
              merma: entry.merma,
              cantidadArte: entry.cantidadArte,
              numeroTiros: entry.numeroTiros,
              formacionUsada: usedValues[i].formacionNum,
              numeroPliegosUsado: usedValues[i].pliegosNum,
              totalPliegos: entry.totalPliegos,
              folio: folio.folio,
            },
            user?.username,
          );
          onOrderCreated(entry.item.id, order);
        } catch (err) {
          logEvent(
            "ERROR",
            `No se pudo guardar la orden de producción del ítem ${entry.item.id}: ${String(err)}`,
            user?.username ?? null,
          );
        }
      }

      setGeneratedItems(items);
    } catch (err) {
      setError(`No se pudo generar el PDF: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  if (generatedItems) {
    return (
      <div className="order-modal-items">
        <p className="hint">Orden generada y PDF guardado.</p>
        {generatedItems.map((item, index) => (
          <div className="order-modal-item" key={item.id ?? index}>
            {generatedItems.length > 1 && <h3>{item.nombre || `Ítem ${index + 1}`}</h3>}
            <div className="form-actions">
              <button type="button" className="btn btn-secondary" onClick={onSwitchToCompra}>
                Crear Compra {generatedItems.length > 1 ? `para "${item.nombre}"` : "para este ítem"}
              </button>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="order-modal-items">
      {items.map((item, index) => {
        const inp = inputs[index];
        const formacionValida = isPureNumber(item.formacion);
        const pliegosValidos = isPureNumber(item.numero_pliegos);
        const computed = computeTotal(item, inp);
        return (
          <div className="order-modal-item" key={item.id ?? index}>
            {items.length > 1 && <h3>{item.nombre || `Ítem ${index + 1}`}</h3>}

            <div className="calculated-field">
              <span className="calculated-field-label">
                Total de tamaños a imprimir con merma
                <span className="calculated-badge">Calculado</span>
              </span>
              <span className="calculated-field-value">{computed?.total ?? "—"}</span>
            </div>

            <div className="calculated-field" style={{ marginTop: "0.6rem" }}>
              <span className="calculated-field-label">
                Total de cambios por pliego a imprimir
                <span className="calculated-badge">Calculado</span>
              </span>
              <span className="calculated-field-value">{computed?.totalPorPliego ?? "—"}</span>
            </div>

            <div className="order-modal-fields" style={{ marginTop: "0.9rem" }}>
              <label>
                Merma
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={inp.merma}
                  onChange={(e) => updateInput(index, "merma", e.target.value)}
                />
              </label>
              <label>
                Cantidad de arte
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={inp.cantidadArte}
                  onChange={(e) => updateInput(index, "cantidadArte", e.target.value)}
                />
              </label>
              <label>
                Número de tiros
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={inp.numeroTiros}
                  onChange={(e) => updateInput(index, "numeroTiros", e.target.value)}
                />
              </label>

              <div className="print-item-view-field">
                <span className="print-item-view-field-label">Tipo de papel</span>
                <span className="print-item-view-field-value">{item.tipo_papel || "—"}</span>
              </div>
              <div className="print-item-view-field">
                <span className="print-item-view-field-label">Gramos o puntos</span>
                <span className="print-item-view-field-value">{item.gramos_puntos || "—"}</span>
              </div>
              <div className="print-item-view-field">
                <span className="print-item-view-field-label">Máquina</span>
                <span className="print-item-view-field-value">{item.maquina || "—"}</span>
              </div>

              <div className="print-item-view-field">
                <span className="print-item-view-field-label">Formación</span>
                <span className="print-item-view-field-value">{item.formacion || "—"}</span>
              </div>
              {!formacionValida && (
                <label>
                  Formación registrada: "{item.formacion || "—"}" — valor numérico a usar
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={inp.formacionOverride}
                    onChange={(e) => updateInput(index, "formacionOverride", e.target.value)}
                  />
                </label>
              )}

              <div className="print-item-view-field">
                <span className="print-item-view-field-label">Tamaño extendido</span>
                <span className="print-item-view-field-value">{item.tamano_extendido || "—"}</span>
              </div>
              <div className="print-item-view-field">
                <span className="print-item-view-field-label">Tamaño Final</span>
                <span className="print-item-view-field-value">{item.tamano_final || "—"}</span>
              </div>

              <div className="print-item-view-field">
                <span className="print-item-view-field-label">Número de pliegos</span>
                <span className="print-item-view-field-value">{item.numero_pliegos || "—"}</span>
              </div>
              {!pliegosValidos && (
                <label>
                  Número de pliegos registrado: "{item.numero_pliegos || "—"}" — valor numérico a
                  usar
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={inp.numeroPliegosOverride}
                    onChange={(e) =>
                      updateInput(index, "numeroPliegosOverride", e.target.value)
                    }
                  />
                </label>
              )}

              <div className="print-item-view-field">
                <span className="print-item-view-field-label">Tintas</span>
                <span className="print-item-view-field-value">{item.tintas || "—"}</span>
              </div>
              <div className="print-item-view-field">
                <span className="print-item-view-field-label">Número de placas</span>
                <span className="print-item-view-field-value">{item.numero_placas || "—"}</span>
              </div>
              <div className="print-item-view-field">
                <span className="print-item-view-field-label">Placas existentes</span>
                <span className="print-item-view-field-value">
                  {PLACAS_EXISTENTES_LABEL[item.placas_existentes]}
                </span>
              </div>

              <div className="print-item-view-field">
                <span className="print-item-view-field-label">Procesos</span>
                <span className="print-item-view-field-value">
                  {item.checks.filter((c) => c.marcado).map((c) => c.nombre).join(", ") ||
                    "Ninguno"}
                </span>
              </div>
            </div>

            {(item.acabados || item.notas) && (
              <div className="print-item-view-section" style={{ marginTop: "0.75rem" }}>
                {item.acabados && (
                  <>
                    <span className="print-item-view-field-label">Acabados</span>
                    <span className="print-item-view-field-value" style={{ whiteSpace: "pre-wrap" }}>
                      {item.acabados}
                    </span>
                  </>
                )}
                {item.notas && (
                  <>
                    <span className="print-item-view-field-label">Notas</span>
                    <span className="print-item-view-field-value" style={{ whiteSpace: "pre-wrap" }}>
                      {item.notas}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}

      {error && <p className="form-error">{error}</p>}

      <div className="form-actions">
        <button className="btn btn-primary" onClick={handleGenerate} disabled={saving}>
          {saving ? "Generando…" : "Generar PDF"}
        </button>
      </div>
    </div>
  );
}
