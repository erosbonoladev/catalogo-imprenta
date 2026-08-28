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

export function skuFromFilename(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).trim();
}

export function classifyImageEntries(
  entries: ImageFileEntry[],
  lookups: Map<string, Product | null>,
): ClassifiedImageRow[] {
  const results: ClassifiedImageRow[] = entries.map((entry, index) => {
    const ext = extensionOf(entry.name);
    const sku = skuFromFilename(entry.name);
    const base = { fila: index + 1, archivo: entry.name, path: entry.path, sku };

    if (!Object.prototype.hasOwnProperty.call(MIME_BY_EXT, ext)) {
      return {
        ...base,
        status: "error" as const,
        reason: `Formato de archivo no compatible (.${ext || "?"}).`,
      };
    }
    if (!sku) {
      return {
        ...base,
        status: "error" as const,
        reason: "No se pudo determinar el código a partir del nombre del archivo.",
      };
    }

    const product = lookups.get(sku) ?? null;
    if (!product) {
      return {
        ...base,
        status: "no-encontrado" as const,
        reason: "No existe una ficha técnica con este código.",
      };
    }
    if (product.imagen) {
      return { ...base, status: "sustituir" as const, matchedProduct: product };
    }
    return { ...base, status: "nueva" as const, matchedProduct: product };
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
