import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import type { PrintItem, Product } from "../types";
import { buildOrderPdf } from "../pdf";
import type { OrderEntry } from "../pdf";

interface Props {
  product: Product;
  items: PrintItem[];
  onClose: () => void;
}

interface ItemInputs {
  merma: string;
  cantidadArte: string;
  formacionOverride: string;
  numeroPliegosOverride: string;
}

const NUMERIC_RE = /^\d+(\.\d+)?$/;

function isPureNumber(value: string): boolean {
  return NUMERIC_RE.test(value.trim());
}

function emptyInputs(): ItemInputs {
  return { merma: "", cantidadArte: "", formacionOverride: "", numeroPliegosOverride: "" };
}

function sanitizeFilename(text: string): string {
  return text.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "orden";
}

export default function OrderModal({ product, items, onClose }: Props) {
  const [inputs, setInputs] = useState<ItemInputs[]>(() => items.map(emptyInputs));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function updateInput(index: number, key: keyof ItemInputs, value: string) {
    setInputs((prev) => prev.map((it, i) => (i === index ? { ...it, [key]: value } : it)));
  }

  async function handleGenerate() {
    setError(null);
    const entries: OrderEntry[] = [];

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

      const merma = parseFloat(inp.merma);
      const cantidadArte = parseFloat(inp.cantidadArte);
      const totalPliegos = Math.ceil((cantidadArte / formacionNum + merma) * pliegosNum);

      entries.push({ item, merma, cantidadArte, totalPliegos });
    }

    setSaving(true);
    try {
      const pdfBytes = buildOrderPdf(product, entries);
      const fecha = new Date().toISOString().slice(0, 10);
      const nombreOrden = items.length > 1 ? "general" : sanitizeFilename(items[0].nombre);
      const defaultPath = `Orden_${sanitizeFilename(product.codigo)}_${nombreOrden}_${fecha}.pdf`;

      const path = await save({
        title: "Guardar orden de impresión",
        defaultPath,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!path) {
        setSaving(false);
        return;
      }
      await writeFile(path, pdfBytes);
      onClose();
    } catch (err) {
      setError(`No se pudo generar el PDF: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        <h2>{items.length > 1 ? "Crear orden general" : `Crear orden: ${items[0].nombre || "(sin nombre)"}`}</h2>
        <p className="hint">
          Ingresa Merma y Cantidad de arte para calcular el Total de pliegos a imprimir.
        </p>

        <div className="order-modal-items">
          {items.map((item, index) => {
            const inp = inputs[index];
            const formacionValida = isPureNumber(item.formacion);
            const pliegosValidos = isPureNumber(item.numero_pliegos);
            return (
              <div className="order-modal-item" key={item.id ?? index}>
                {items.length > 1 && <h3>{item.nombre || `Ítem ${index + 1}`}</h3>}
                <div className="order-modal-fields">
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
                  {!pliegosValidos && (
                    <label>
                      Número de pliegos registrado: "{item.numero_pliegos || "—"}" — valor numérico
                      a usar
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
                </div>
              </div>
            );
          })}
        </div>

        {error && <p className="form-error">{error}</p>}

        <div className="form-actions">
          <button className="btn btn-primary" onClick={handleGenerate} disabled={saving}>
            {saving ? "Generando…" : "Generar PDF"}
          </button>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
