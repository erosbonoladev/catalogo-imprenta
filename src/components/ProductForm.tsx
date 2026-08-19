import { useEffect, useState, type FormEvent } from "react";
import {
  codigoEnUso,
  createProduct,
  getImageSrc,
  getProduct,
  getProductSpecs,
  pickAndSaveImage,
  updateProduct,
} from "../db";
import type { ProductInput, ProductSpec } from "../types";

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
  const [product, setProduct] = useState<ProductInput>(emptyProduct);
  const [specs, setSpecs] = useState<ProductSpec[]>([]);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
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
    setProduct((prev) => ({ ...prev, [key]: value }));
  }

  function updateSpec(index: number, key: "etiqueta" | "valor", value: string) {
    setSpecs((prev) =>
      prev.map((spec, i) => (i === index ? { ...spec, [key]: value } : spec)),
    );
  }

  function addSpecRow() {
    setSpecs((prev) => [...prev, { etiqueta: "", valor: "", orden: prev.length + 1 }]);
  }

  function removeSpecRow(index: number) {
    setSpecs((prev) => prev.filter((_, i) => i !== index));
  }

  async function handlePickImage() {
    const filename = await pickAndSaveImage(product.codigo);
    if (!filename) return;
    updateField("imagen", filename);
    setImageSrc(await getImageSrc(filename));
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
            <input
              type="text"
              value={product.codigo}
              onChange={(e) => updateField("codigo", e.target.value)}
              placeholder="ej. 3072"
              required
            />
          </label>
          <label>
            Nombre
            <input
              type="text"
              value={product.nombre}
              onChange={(e) => updateField("nombre", e.target.value)}
              placeholder="ej. Tangram"
              required
            />
          </label>
        </div>

        <div className="form-row">
          <label>
            Categoría
            <input
              type="text"
              value={product.categoria}
              onChange={(e) => updateField("categoria", e.target.value)}
              placeholder="ej. Juegos didácticos"
            />
          </label>
          <label>
            Material
            <input
              type="text"
              value={product.material}
              onChange={(e) => updateField("material", e.target.value)}
              placeholder="ej. Plástico, Madera"
            />
          </label>
        </div>

        <label>
          Descripción
          <textarea
            value={product.descripcion}
            onChange={(e) => updateField("descripcion", e.target.value)}
            rows={3}
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
              <input
                type="text"
                placeholder="Etiqueta (ej. Dimensiones)"
                value={spec.etiqueta}
                onChange={(e) => updateSpec(index, "etiqueta", e.target.value)}
              />
              <input
                type="text"
                placeholder="Valor (ej. 15 x 15 cm)"
                value={spec.valor}
                onChange={(e) => updateSpec(index, "valor", e.target.value)}
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
          <button type="submit" className="btn btn-primary" disabled={saving}>
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
