import { useEffect, useState, type FormEvent } from "react";
import {
  codigoEnUso,
  createProduct,
  getImageSrc,
  getProduct,
  getProductDescriptions,
  getProductSpecs,
  logEvent,
  pickImage,
  updateProduct,
} from "../db";
import type { ProductDescription, ProductInput, ProductSpec } from "../types";
import { DESCRIPCIONES_FIJAS, DESCRIPCION_CATALOGO, ensureFixedDescriptions } from "../descriptions";
import { useAuth } from "../auth";
import AutoGrowInput from "./AutoGrowInput";
import basuraIcon from "../../Assets/basura.svg";

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
  const [descriptions, setDescriptions] = useState<ProductDescription[]>(
    ensureFixedDescriptions([]),
  );
  const [activeDescTab, setActiveDescTab] = useState(0);
  const [addingDescription, setAddingDescription] = useState(false);
  const [newDescNombre, setNewDescNombre] = useState("");
  const [newDescTexto, setNewDescTexto] = useState("");
  const [descError, setDescError] = useState<string | null>(null);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!productId) return;
    (async () => {
      const [existing, existingSpecs, existingDescriptions] = await Promise.all([
        getProduct(productId),
        getProductSpecs(productId),
        getProductDescriptions(productId),
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
      setDescriptions(ensureFixedDescriptions(existingDescriptions));
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

  function toggleSpecRequisicion(index: number) {
    setDirty(true);
    setSpecs((prev) =>
      prev.map((spec, i) =>
        i === index ? { ...spec, permite_requisicion: !spec.permite_requisicion } : spec,
      ),
    );
  }

  function addSpecRow() {
    setDirty(true);
    setSpecs((prev) => [
      ...prev,
      { etiqueta: "", valor: "", orden: prev.length + 1, permite_requisicion: false },
    ]);
  }

  function removeSpecRow(index: number) {
    setDirty(true);
    setSpecs((prev) => prev.filter((_, i) => i !== index));
  }

  function updateDescriptionText(index: number, value: string) {
    setDirty(true);
    setDescriptions((prev) =>
      prev.map((d, i) => (i === index ? { ...d, texto: value } : d)),
    );
  }

  function removeDescription(index: number) {
    setDirty(true);
    setDescriptions((prev) => prev.filter((_, i) => i !== index));
    setActiveDescTab(0);
  }

  function handleAddDescription() {
    const nombre = newDescNombre.trim();
    if (!nombre) {
      setDescError("El nombre de la descripción es obligatorio.");
      return;
    }
    const nombresExistentes = [DESCRIPCION_CATALOGO, ...descriptions.map((d) => d.etiqueta)].map(
      (n) => n.trim().toLowerCase(),
    );
    if (nombresExistentes.includes(nombre.toLowerCase())) {
      setDescError(`Ya existe una descripción llamada "${nombre}".`);
      return;
    }
    setDirty(true);
    const nuevoIndex = descriptions.length;
    setDescriptions((prev) => [...prev, { etiqueta: nombre, texto: newDescTexto.trim(), orden: 0 }]);
    setActiveDescTab(nuevoIndex + 1);
    setNewDescNombre("");
    setNewDescTexto("");
    setAddingDescription(false);
    setDescError(null);
  }

  function handleCancelAddDescription() {
    setNewDescNombre("");
    setNewDescTexto("");
    setAddingDescription(false);
    setDescError(null);
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
        await updateProduct(productId, payload, specs, descriptions);
        id = productId;
      } else {
        id = await createProduct(payload, specs, descriptions);
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

        <div className="descriptions-editor">
          <h2>Descripciones</h2>
          <div className="descriptions-tabs" role="tablist" aria-label="Tipo de descripción">
            <button
              type="button"
              role="tab"
              aria-selected={activeDescTab === 0}
              className={`filter-chip${activeDescTab === 0 ? " filter-chip-active" : ""}`}
              onClick={() => setActiveDescTab(0)}
            >
              {DESCRIPCION_CATALOGO}
            </button>
            {descriptions.map((d, index) => (
              <button
                key={index}
                type="button"
                role="tab"
                aria-selected={activeDescTab === index + 1}
                className={`filter-chip${activeDescTab === index + 1 ? " filter-chip-active" : ""}`}
                onClick={() => setActiveDescTab(index + 1)}
              >
                {d.etiqueta}
              </button>
            ))}
            <button
              type="button"
              className="btn-link descriptions-add-btn"
              onClick={() => setAddingDescription(true)}
            >
              + Agregar nueva descripción
            </button>
          </div>

          {activeDescTab === 0 ? (
            <AutoGrowInput
              multiline
              value={product.descripcion}
              onChange={(v) => updateField("descripcion", v)}
              placeholder="Descripción para el catálogo"
            />
          ) : (
            <div className="description-tab-content">
              <AutoGrowInput
                multiline
                value={descriptions[activeDescTab - 1]?.texto ?? ""}
                onChange={(v) => updateDescriptionText(activeDescTab - 1, v)}
                placeholder={`Descripción para ${descriptions[activeDescTab - 1]?.etiqueta ?? ""}`}
              />
              {activeDescTab - 1 >= DESCRIPCIONES_FIJAS.length && (
                <button
                  type="button"
                  className="icon-btn icon-btn-remove"
                  onClick={() => removeDescription(activeDescTab - 1)}
                  title="Quitar esta descripción"
                  aria-label="Quitar esta descripción"
                >
                  <img src={basuraIcon} alt="" aria-hidden="true" />
                </button>
              )}
            </div>
          )}

          {addingDescription && (
            <div className="description-add-form">
              <label>
                Nombre de la descripción
                <AutoGrowInput
                  value={newDescNombre}
                  onChange={setNewDescNombre}
                  placeholder="ej. Redes sociales"
                />
              </label>
              <label>
                Descripción
                <AutoGrowInput multiline value={newDescTexto} onChange={setNewDescTexto} />
              </label>
              {descError && <p className="form-error">{descError}</p>}
              <div className="form-actions">
                <button type="button" className="btn btn-primary" onClick={handleAddDescription}>
                  Guardar
                </button>
                <button type="button" className="btn btn-secondary" onClick={handleCancelAddDescription}>
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </div>

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
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={spec.permite_requisicion}
                  onChange={() => toggleSpecRequisicion(index)}
                />
                Permitir requisición
              </label>
              <button
                type="button"
                className="icon-btn icon-btn-remove"
                onClick={() => removeSpecRow(index)}
                title="Quitar especificación"
                aria-label="Quitar especificación"
              >
                <img src={basuraIcon} alt="" aria-hidden="true" />
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
