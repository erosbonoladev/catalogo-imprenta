import type { PlasticProductInput } from "../types";
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
  tipo_empaque: "",
  imagen: null,
  imagen_codigo_barras: null,
};

interface Props {
  data: PlasticProductInput;
  imageSrc: string | null;
  barcodeSrc: string | null;
  onChange: (patch: Partial<PlasticProductInput>) => void;
  onPickImage: () => void;
  onPickBarcode: () => void;
}

export default function PlasticProductFields({
  data,
  imageSrc,
  barcodeSrc,
  onChange,
  onPickImage,
  onPickBarcode,
}: Props) {
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
        <div className="plastic-item-barcode-box">
          {barcodeSrc ? (
            <img src={barcodeSrc} alt="Código de barras" />
          ) : (
            <span className="product-card-placeholder">Sin código de barras</span>
          )}
          <button type="button" className="btn btn-secondary" onClick={onPickBarcode}>
            {barcodeSrc ? "Cambiar código de barras" : "Agregar código de barras"}
          </button>
        </div>
      </div>

      <div className="plastic-item-fields">
        <PlasticField label="SKU" value={data.sku} onChange={(v) => onChange({ sku: v })} />
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
        <PlasticField
          label="Tipo de empaque"
          value={data.tipo_empaque}
          onChange={(v) => onChange({ tipo_empaque: v })}
        />
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
