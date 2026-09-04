import { MIME_BY_EXT } from "./db";
import type { Product } from "./types";

export interface ImageFileEntry {
  name: string;
  path: string;
}

export type ImageRowStatus = "nueva" | "sustituir" | "no-encontrado" | "error";

export interface ClassifiedImageRow {
  fila: number;
  archivo: string;
  path: string;
  sku: string;
  status: ImageRowStatus;
  reason?: string;
  matchedProduct?: Product;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

// Separador explícito entre SKU y nombre: espacio o guion, donde sea que
// aparezca primero en el nombre de archivo (ej. "7145-Tapete-De-Texturas"
// -> "7145"; "7145 - Tapete" -> "7145"). No se puede asumir que el PRIMER
// guion del archivo sea el separador — el nombre del producto casi siempre
// trae guiones propios más adelante ("Circulos-Del-Conocimiento"), así que
// esto se combina con GLUED_WORD_START_RE de abajo y se usa el que aparezca
// primero.
const SEPARATOR_RE = /[ -]/;
// Nombre pegado al SKU sin separador (ej. "7234Circulos..." -> "7234"):
// dígito seguido de una Mayúscula seguida de una minúscula, es decir el
// arranque de una palabra en Mayúscula. Deliberadamente NO dispara con solo
// dígito+Mayúscula al final del texto (ej. "8059C" sin nada más después),
// para no cortar una variante de SKU con letra final (mismo patrón que
// computeSkuPrincipal en precios.ts) cuando no trae nombre pegado.
// Caso límite conocido: una variante con letra pegada directo a un nombre
// sin separador (ej. "8059CProducto.jpg") no se separa — el archivo
// completo queda como SKU, degradando al comportamiento anterior (no
// encontrado) en vez de partir mal.
const GLUED_WORD_START_RE = /\d[A-Z][a-z]/;

export function skuFromFilename(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = (dot > 0 ? name.slice(0, dot) : name).trim();

  const sepIndex = stem.search(SEPARATOR_RE);
  const gluedMatch = stem.match(GLUED_WORD_START_RE);
  const gluedIndex = gluedMatch?.index !== undefined ? gluedMatch.index + 1 : -1;

  const candidates = [sepIndex, gluedIndex].filter((i) => i !== -1);
  const cut = candidates.length > 0 ? Math.min(...candidates) : stem.length;

  return stem.slice(0, cut).trim();
}

// Nombre de archivo completo, sin extensión, sin recortar — el
// comportamiento de match "de siempre" (el código es el archivo completo).
// Se sigue probando primero en classifyImageEntries antes que el SKU
// recortado, así un código que ya trae guion propio (ej. "ABC-123") y que
// hoy coincide exacto con el nombre del archivo COMPLETO sigue
// coincidiendo igual — el recorte solo entra a tallar cuando el nombre
// completo no es un código real.
export function fullStemFromFilename(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).trim();
}

export function classifyImageEntries(
  entries: ImageFileEntry[],
  lookups: Map<string, Product | null>,
): ClassifiedImageRow[] {
  const results: ClassifiedImageRow[] = entries.map((entry, index) => {
    const ext = extensionOf(entry.name);
    const fullStem = fullStemFromFilename(entry.name);
    const extractedSku = skuFromFilename(entry.name);
    const base = { fila: index + 1, archivo: entry.name, path: entry.path };

    if (!Object.prototype.hasOwnProperty.call(MIME_BY_EXT, ext)) {
      return {
        ...base,
        sku: extractedSku,
        status: "error" as const,
        reason: `Formato de archivo no compatible (.${ext || "?"}).`,
      };
    }
    if (!extractedSku) {
      return {
        ...base,
        sku: extractedSku,
        status: "error" as const,
        reason: "No se pudo determinar el código a partir del nombre del archivo.",
      };
    }

    const fullMatch = fullStem !== extractedSku ? (lookups.get(fullStem) ?? null) : null;
    const product = fullMatch ?? lookups.get(extractedSku) ?? null;
    const sku = fullMatch ? fullStem : extractedSku;

    if (!product) {
      return {
        ...base,
        sku: extractedSku,
        status: "no-encontrado" as const,
        reason: "No existe una ficha técnica con este código — se guardará para aplicarse automáticamente si se crea a futuro.",
      };
    }
    if (product.imagen) {
      return { ...base, sku, status: "sustituir" as const, matchedProduct: product };
    }
    return { ...base, sku, status: "nueva" as const, matchedProduct: product };
  });

  // Dos archivos distintos de la misma carpeta que resuelven al mismo código
  // (ej. "SKU001.jpg" y "SKU001.png") — el segundo se marca como error en
  // vez de sobrescribirse en silencio uno a otro durante la importación.
  const seenSku = new Map<string, number>();
  for (const row of results) {
    if (row.status === "error" || !row.sku) continue;
    const key = row.sku.toLowerCase();
    const firstFila = seenSku.get(key);
    if (firstFila !== undefined) {
      row.status = "error";
      row.reason = `Código repetido en la carpeta — ya aparece en la fila ${firstFila}.`;
      row.matchedProduct = undefined;
      continue;
    }
    seenSku.set(key, row.fila);
  }

  return results;
}
