import { BARCODE_IMAGE_EXTENSIONS, type BarcodeMatch, type ImageFolderEntry } from "./db";

export type BarcodeImageRowStatus = "nueva" | "sustituir" | "no-encontrado" | "error";

export interface ClassifiedBarcodeRow {
  fila: number;
  carpeta: string;
  archivo: string | null;
  path: string | null;
  status: BarcodeImageRowStatus;
  reason?: string;
  matchedProduct?: BarcodeMatch;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

const DIGITS_ONLY_RE = /^\d+$/;

// Dentro de una carpeta de código de barras (nombrada con el número), el
// único archivo válido es el que se llama exactamente igual a ese número:
// solo dígitos, sin "-" adelante ni ningún sufijo — variantes con guion u
// otro texto se ignoran. Si no hay ninguno o hay más de uno, es un error de
// esa fila (no se adivina cuál usar).
export function pickBarcodeFile(
  folderName: string,
  files: ImageFolderEntry[],
): { file: ImageFolderEntry } | { error: string } {
  const matches = files.filter((f) => {
    const ext = extensionOf(f.name);
    if (!BARCODE_IMAGE_EXTENSIONS.has(ext)) return false;
    const stem = stemOf(f.name);
    return DIGITS_ONLY_RE.test(stem) && stem === folderName;
  });
  if (matches.length === 0) {
    return {
      error: `No se encontró un archivo llamado "${folderName}" (solo números, sin guion adelante) dentro de la carpeta.`,
    };
  }
  if (matches.length > 1) {
    return {
      error: `Hay más de un archivo válido (${matches.map((m) => m.name).join(", ")}) — no se sabe cuál usar.`,
    };
  }
  return { file: matches[0] };
}

export function classifyBarcodeFolders(
  folders: ImageFolderEntry[],
  filesByFolder: Map<string, ImageFolderEntry[]>,
  lookups: Map<string, BarcodeMatch[]>,
): ClassifiedBarcodeRow[] {
  return folders.map((folder, index) => {
    const base = { fila: index + 1, carpeta: folder.name };
    const picked = pickBarcodeFile(folder.name, filesByFolder.get(folder.path) ?? []);
    if ("error" in picked) {
      return { ...base, archivo: null, path: null, status: "error" as const, reason: picked.error };
    }

    const products = lookups.get(folder.name) ?? [];
    if (products.length === 0) {
      return {
        ...base,
        archivo: picked.file.name,
        path: picked.file.path,
        status: "no-encontrado" as const,
        reason: "No existe ninguna ficha técnica con este código de barras — se guardará para aplicarse automáticamente si se crea a futuro.",
      };
    }
    if (products.length > 1) {
      return {
        ...base,
        archivo: picked.file.name,
        path: picked.file.path,
        status: "error" as const,
        reason: `Más de una ficha técnica tiene este código de barras (${products.map((p) => p.codigo).join(", ")}).`,
      };
    }

    const product = products[0];
    const status: BarcodeImageRowStatus = product.tieneImagenBarras ? "sustituir" : "nueva";
    return {
      ...base,
      archivo: picked.file.name,
      path: picked.file.path,
      status,
      matchedProduct: product,
    };
  });
}
