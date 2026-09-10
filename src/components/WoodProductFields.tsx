import { useEffect, useState } from "react";
import type { WoodProductInput } from "../types";
import { parseAmount } from "../precios";
import { formatMoney } from "../excelExport";
import AutoGrowInput from "./AutoGrowInput";

export const EMPTY_WOOD_DATA: WoodProductInput = {
  nombre: "",
  sku: "",
  tamano: "",
  capas: "",
  largo: "",
  ancho: "",
  espesor: "",
  caben_hoja_mdf: "",
  minutos_laser: "",
  importe_madera: null,
  pintura: null,
  importe_corte_laser: null,
  etiqueta_adhesiva: null,
  otro_importe: null,
  otro_concepto: "",
  etiqueta_empaque: null,
  costo_total: null,
  precio_venta: null,
  imagen: null,
};

interface Props {
  data: WoodProductInput;
  imageSrc: string | null;
  onChange: (patch: Partial<WoodProductInput>) => void;
  onPickImage: () => void;
}

export default function WoodProductFields({ data, imageSrc, onChange, onPickImage }: Props) {
  const fields = (
    <div className="plastic-item-fields">
      <TextField label="SKU" value={data.sku} onChange={(v) => onChange({ sku: v })} />
      <TextField label="Tamaño" value={data.tamano} onChange={(v) => onChange({ tamano: v })} />
      <TextField label="Capas" value={data.capas} onChange={(v) => onChange({ capas: v })} />
      <TextField label="Largo" value={data.largo} onChange={(v) => onChange({ largo: v })} />
      <TextField label="Ancho" value={data.ancho} onChange={(v) => onChange({ ancho: v })} />
      <TextField
        label="Espesor de la madera"
        value={data.espesor}
        onChange={(v) => onChange({ espesor: v })}
      />
      <TextField
        label="Caben en una hoja de MDF 122 x 244"
        value={data.caben_hoja_mdf}
        onChange={(v) => onChange({ caben_hoja_mdf: v })}
      />
      <TextField
        label="Minutos en láser"
        value={data.minutos_laser}
        onChange={(v) => onChange({ minutos_laser: v })}
      />
      <MoneyField
        label="Importe madera"
        value={data.importe_madera}
        onChange={(v) => onChange({ importe_madera: v })}
      />
      <MoneyField label="Pintura" value={data.pintura} onChange={(v) => onChange({ pintura: v })} />
      <MoneyField
        label="Importe corte láser"
        value={data.importe_corte_laser}
        onChange={(v) => onChange({ importe_corte_laser: v })}
      />
      <MoneyField
        label="Etiqueta adhesiva"
        value={data.etiqueta_adhesiva}
        onChange={(v) => onChange({ etiqueta_adhesiva: v })}
      />
      <MoneyField
        label="Otro"
        value={data.otro_importe}
        onChange={(v) => onChange({ otro_importe: v })}
      />
      <TextField
        label="Concepto de Otro"
        value={data.otro_concepto}
        onChange={(v) => onChange({ otro_concepto: v })}
      />
      <MoneyField
        label="Etiqueta empaque"
        value={data.etiqueta_empaque}
        onChange={(v) => onChange({ etiqueta_empaque: v })}
      />
      <MoneyField
        label="Costo total"
        value={data.costo_total}
        onChange={(v) => onChange({ costo_total: v })}
      />
      <MoneyField
        label="Precio venta"
        value={data.precio_venta}
        onChange={(v) => onChange({ precio_venta: v })}
      />
    </div>
  );

  return (
    <>
      {fields}
      <div className="wood-item-image-box">
        <span className="print-item-checks-label">Foto del producto</span>
        <div className="wood-item-image-frame">
          {imageSrc ? (
            <img src={imageSrc} alt={data.nombre || "Producto de madera"} />
          ) : (
            <span className="product-card-placeholder">Sin imagen</span>
          )}
        </div>
        <button type="button" className="btn btn-secondary" onClick={onPickImage}>
          {imageSrc ? "Cambiar imagen" : "Agregar imagen"}
        </button>
      </div>
    </>
  );
}

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

function TextField({ label, value, onChange }: TextFieldProps) {
  return (
    <label className="plastic-item-field">
      <span>{label}</span>
      <AutoGrowInput value={value} onChange={onChange} />
    </label>
  );
}

interface MoneyFieldProps {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
}

// Los campos de dinero se guardan como número (pedido explícito del
// usuario: "los valores monetarios deben tratarse como números, no como
// texto"), pero el input debe seguir el texto tal como lo teclea el usuario
// — si el input estuviera atado directo al número parseado, escribir un
// punto decimal ("1." antes de seguir con "5") se borraría solo en cada
// tecla, porque "1." no es un número válido todavía. Se mantiene un draft
// de texto local que solo empuja hacia arriba (onChange) cuando el texto sí
// parsea a un número — mismo criterio que RemisionForm (cantidad/precio
// como string en el draft, parseAmount solo al calcular/guardar).
function MoneyField({ label, value, onChange }: MoneyFieldProps) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));

  useEffect(() => {
    setDraft(value === null ? "" : String(value));
  }, [value]);

  return (
    <label className="plastic-item-field">
      <span>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          if (raw.trim() === "") {
            onChange(null);
            return;
          }
          const parsed = parseAmount(raw);
          if (parsed !== null) onChange(parsed);
        }}
      />
    </label>
  );
}

export function formatWoodMoney(value: number | null): string {
  return value === null ? "—" : formatMoney(value);
}
