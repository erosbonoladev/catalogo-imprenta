import type { ReactNode } from "react";
import type { PlasticProductInput } from "../types";
import { isInsumoSku } from "../insumos";
import AutoGrowInput from "./AutoGrowInput";

const ORIGENES = ["BOD", "GIL", "IMPR", "EXTR"] as const;

export const EMPTY_PLASTIC_DATA: PlasticProductInput = {
  nombre: "",
  sku: "",
  color: "",
  origen: "",
  descripcion: "",
  material: "",
  dimension: "",
  peso: "",
  maquila: "",
  coste: "",
  componentes_fabricacion: "",
  precio_por_pieza: "",
  precio_por_juego: "",
  es_insumo: false,
  imagen: null,
};

interface Props {
  data: PlasticProductInput;
  imageSrc: string | null;
  onChange: (patch: Partial<PlasticProductInput>) => void;
  onPickImage: () => void;
  // Campos que no viven en plastic_products (ej. Cantidad, propia del
  // vínculo ficha↔pieza en PlasticosSection) pero que deben verse junto al
  // resto en la misma grilla — solo PlasticosSection la usa hoy,
  // PiezasGeneralSection/PiezaFormModal la omiten sin cambios.
  extraFields?: ReactNode;
}

export default function PlasticProductFields({
  data,
  imageSrc,
  onChange,
  onPickImage,
  extraFields,
}: Props) {
  // Un insumo ya guardado tiene su SKU INS-NNNN asignado y permanente: ni se
  // edita ni se puede desmarcar. Uno recién marcado muestra el aviso hasta que
  // el guardado le asigne el número (la base lo calcula, no este formulario).
  const insumoGuardado = data.es_insumo === true && isInsumoSku(data.sku);
  const insumoPendiente = data.es_insumo === true && !insumoGuardado;
  return (
    <>
      <div className="plastic-item-media-col">
        <div className="plastic-item-image-box">
          {imageSrc ? (
            <img src={imageSrc} alt={data.nombre || "Producto"} />
          ) : (
            <span className="product-card-placeholder">Sin imagen</span>
          )}
          <button type="button" className="btn btn-secondary" onClick={onPickImage}>
            {imageSrc ? "Cambiar imagen" : "Agregar imagen"}
          </button>
        </div>
      </div>

      <div className="plastic-item-fields">
        {extraFields}
        <label className="plastic-item-field">
          <span>SKU</span>
          {insumoGuardado ? (
            <input type="text" value={data.sku} readOnly />
          ) : insumoPendiente ? (
            <input type="text" value="INS-#### (se asigna al guardar)" readOnly />
          ) : (
            <AutoGrowInput value={data.sku} onChange={(v) => onChange({ sku: v })} />
          )}
        </label>
        <PlasticField label="Color" value={data.color} onChange={(v) => onChange({ color: v })} />
        <label className="plastic-item-field">
          <span>Origen</span>
          <select value={data.origen} onChange={(e) => onChange({ origen: e.target.value })}>
            <option value="">Sin definir</option>
            {ORIGENES.map((origen) => (
              <option key={origen} value={origen}>
                {origen}
              </option>
            ))}
          </select>
        </label>
        <PlasticField label="Material" value={data.material} onChange={(v) => onChange({ material: v })} />
        <PlasticField
          label="Dimensión"
          value={data.dimension}
          onChange={(v) => onChange({ dimension: v })}
        />
        <PlasticField label="Peso" value={data.peso} onChange={(v) => onChange({ peso: v })} />
        <PlasticField label="Maquila" value={data.maquila} onChange={(v) => onChange({ maquila: v })} />
        <PlasticField
          label="Precio por pieza"
          value={data.precio_por_pieza}
          onChange={(v) => onChange({ precio_por_pieza: v })}
        />
        <PlasticField
          label="Precio por juego"
          value={data.precio_por_juego}
          onChange={(v) => onChange({ precio_por_juego: v })}
        />
        <label
          className="plastic-item-field checkbox-label"
          title={insumoGuardado ? "Un insumo guardado no puede volver a ser pieza" : undefined}
        >
          <input
            type="checkbox"
            checked={data.es_insumo === true}
            disabled={insumoGuardado}
            onChange={(e) => onChange({ es_insumo: e.target.checked })}
          />
          Insumos
        </label>
      </div>
    </>
  );
}

interface PlasticFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

function PlasticField({ label, value, onChange }: PlasticFieldProps) {
  return (
    <label className="plastic-item-field">
      <span>{label}</span>
      <AutoGrowInput value={value} onChange={onChange} />
    </label>
  );
}
