import type { ProductDescription } from "./types";

export const DESCRIPCION_CATALOGO = "Catálogo";

export const DESCRIPCIONES_FIJAS = ["Página web", "Licitación"] as const;

export interface DescriptionSlot {
  etiqueta: string;
  texto: string;
  removable: boolean;
}

/**
 * Arma la lista completa de descripciones de un producto: Catálogo (siempre
 * primero, viene de products.descripcion) + los tipos fijos (Página web,
 * Licitación, con texto vacío si aún no existe fila) + cualquier tipo
 * adicional que el usuario haya agregado, en el orden guardado.
 */
export function buildDescriptionSlots(
  descripcionCatalogo: string,
  descriptions: ProductDescription[],
): DescriptionSlot[] {
  const porEtiqueta = new Map(descriptions.map((d) => [d.etiqueta, d]));

  const fijas: DescriptionSlot[] = DESCRIPCIONES_FIJAS.map((etiqueta) => ({
    etiqueta,
    texto: porEtiqueta.get(etiqueta)?.texto ?? "",
    removable: false,
  }));

  const fijasSet: readonly string[] = DESCRIPCIONES_FIJAS;
  const personalizadas: DescriptionSlot[] = descriptions
    .filter((d) => !fijasSet.includes(d.etiqueta))
    .sort((a, b) => a.orden - b.orden)
    .map((d) => ({ etiqueta: d.etiqueta, texto: d.texto, removable: true }));

  return [
    { etiqueta: DESCRIPCION_CATALOGO, texto: descripcionCatalogo, removable: false },
    ...fijas,
    ...personalizadas,
  ];
}

/**
 * Para edición: garantiza que los tipos fijos (Página web, Licitación)
 * siempre tengan una entrada en el arreglo (vacía si aún no existe fila en
 * BD), en posición estable, seguidos de los tipos personalizados en el
 * orden guardado. Catálogo no entra aquí — se edita aparte, atado a
 * products.descripcion.
 */
export function ensureFixedDescriptions(
  existing: ProductDescription[],
): ProductDescription[] {
  const porEtiqueta = new Map(existing.map((d) => [d.etiqueta, d]));
  const fijas: ProductDescription[] = DESCRIPCIONES_FIJAS.map((etiqueta) => ({
    ...(porEtiqueta.get(etiqueta) ?? { etiqueta, texto: "", orden: 0 }),
  }));
  const fijasSet: readonly string[] = DESCRIPCIONES_FIJAS;
  const personalizadas = existing.filter((d) => !fijasSet.includes(d.etiqueta));
  return [...fijas, ...personalizadas];
}
