import { useEffect, useState, type FormEvent } from "react";
import {
  codigoEnUso,
  createProduct,
  getImageSrc,
  getProduct,
  getProductSpecs,
  logEvent,
  pickImage,
  updateProduct,
} from "../db";
import type { ProductInput, ProductSpec } from "../types";
import { useAuth } from "../auth";
import AutoGrowInput from "./AutoGrowInput";

interface Props {
  productId?: number;
  onDone: (id: number) => void;
  onCancel: () => void;
}

const emptyProduct: ProductInput = {
  codigo: "",
  nombre: "",
  categoria: "",
  material: "",
  descripcion: "",
  imagen: null,
};

export default function ProductForm({ productId, onDone, onCancel }: Props) {
  const { user } = useAuth();
  const [product, setProduct] = useState<ProductInput>(emptyProduct);
  const [specs, setSpecs] = useState<ProductSpec[]>([]);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!productId) return;
    (async () => {
      const [existing, existingSpecs] = await Promise.all([
        getProduct(productId),
        getProductSpecs(productId),
      ]);
      if (!existing) return;
      setProduct({
        codigo: existing.codigo,
        nombre: existing.nombre,
        categoria: existing.categoria,
        material: existing.material,
        descripcion: existing.descripcion,
        imagen: existing.imagen,
      });
      setSpecs(existingSpecs);
      setImageSrc(await getImageSrc(existing.imagen));
    })();
  }, [productId]);

  function updateField<K extends keyof ProductInput>(key: K, value: ProductInput[K]) {
    setDirty(true);
    setProduct((prev) => ({ ...prev, [key]: value }));
  }

  function updateSpec(index: number, key: "etiqueta" | "valor", value: string) {
    setDirty(true);
    setSpecs((prev) =>
      prev.map((spec, i) => (i === index ? { ...spec, [key]: value } : spec)),
    );
  }

  function addSpecRow() {
    setDirty(true);
    setSpecs((prev) => [...prev, { etiqueta: "", valor: "", orden: prev.length + 1 }]);
  }

  function removeSpecRow(index: number) {
    setDirty(true);
    setSpecs((prev) => prev.filter((_, i) => i !== index));
  }

  async function handlePickImage() {
    const image = await pickImage();
    if (!image) return;
    updateField("imagen", image);
    setImageSrc(await getImageSrc(image));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const codigo = product.codigo.trim();
    const nombre = product.nombre.trim();
    if (!codigo || !nombre) {
      setError("El código y el nombre son obligatorios.");
      return;
    }

    if (await codigoEnUso(codigo, productId)) {
      setError(`Ya existe un producto con el código "${codigo}".`);
      return;
    }

    setSaving(true);
    try {
      const payload: ProductInput = { ...product, codigo, nombre };
      let id: number;
      if (productId) {
        await updateProduct(productId, payload, specs);
        id = productId;
      } else {
        id = await createProduct(payload, specs);
      }
      onDone(id);
    } catch (err) {
      setError(`No se pudo guardar el producto: ${String(err)}`);
      logEvent("ERROR", `No se pudo guardar el producto: ${String(err)}`, user?.username ?? null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="product-form">
      <button className="btn-link" onClick={onCancel}>
        ← Cancelar
      </button>

      <h1>{productId ? "Editar ficha técnica" : "Nuevo producto"}</h1>

      <form onSubmit={handleSubmit}>
        <div className="form-row">
          <label>
            Código
            <AutoGrowInput
              value={product.codigo}
              onChange={(v) => updateField("codigo", v)}
              placeholder="ej. 3072"
              required
            />
          </label>
          <label>
            Nombre
            <AutoGrowInput
              value={product.nombre}
              onChange={(v) => updateField("nombre", v)}
              placeholder="ej. Tangram"
              required
            />
          </label>
        </div>

        <div className="form-row">
          <label>
            Categoría
            <AutoGrowInput
              value={product.categoria}
              onChange={(v) => updateField("categoria", v)}
              placeholder="ej. Juegos didácticos"
            />
          </label>
          <label>
            Material
            <AutoGrowInput
              value={product.material}
              onChange={(v) => updateField("material", v)}
              placeholder="ej. Plástico, Madera"
            />
          </label>
        </div>

        <label>
          Descripción
          <AutoGrowInput
            multiline
            value={product.descripcion}
            onChange={(v) => updateField("descripcion", v)}
          />
        </label>

        <div className="image-picker">
          {imageSrc && <img src={imageSrc} alt="Vista previa" />}
          <button type="button" className="btn btn-secondary" onClick={handlePickImage}>
            {imageSrc ? "Cambiar imagen" : "Seleccionar imagen de referencia"}
          </button>
        </div>

        <div className="specs-editor">
          <h2>Especificaciones técnicas</h2>
          {specs.map((spec, index) => (
            <div className="spec-row" key={index}>
              <AutoGrowInput
                placeholder="Etiqueta (ej. Dimensiones)"
                value={spec.etiqueta}
                onChange={(v) => updateSpec(index, "etiqueta", v)}
              />
              <AutoGrowInput
                placeholder="Valor (ej. 15 x 15 cm)"
                value={spec.valor}
                onChange={(v) => updateSpec(index, "valor", v)}
              />
              <button
                type="button"
                className="btn-link"
                onClick={() => removeSpecRow(index)}
              >
                Quitar
              </button>
            </div>
          ))}
          <button type="button" className="btn-link" onClick={addSpecRow}>
            + Agregar especificación
          </button>
        </div>

        {error && <p className="form-error">{error}</p>}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={saving || !dirty}>
            {saving ? "Guardando…" : "Guardar"}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancelar
          </button>
        </div>
      </form>
    </div>
  );
}
