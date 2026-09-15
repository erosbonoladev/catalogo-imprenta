import * as XLSX from "xlsx";
import { PRECIOS_VENTA_CATEGORIAS, TIPOS_PRODUCTO, type PrecioVentaCategoria, type Product } from "./types";

export const EXPECTED_HEADERS = [
  "SKU",
  "Producto",
  "Categoría",
  "Tipo de producto",
  "Código de barras",
  "Gobierno",
  "Representante",
  "Mayoreo",
  "Medio mayoreo",
  "Público sugerido",
] as const;

type ExpectedHeader = (typeof EXPECTED_HEADERS)[number];

function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export interface RawCorreccionRow {
  fila: number;
  sku: string;
  producto: string;
  categoria: string;
  tipoProducto: string;
  codigoBarras: string;
  gobiernoRaw: unknown;
  representanteRaw: unknown;
  mayoreoRaw: unknown;
  medioMayoreoRaw: unknown;
  publicoSugeridoRaw: unknown;
}

export type WorkbookReadResult =
  | { ok: true; rows: RawCorreccionRow[] }
  | { ok: false; missingHeaders: string[] };

export function readWorkbook(bytes: Uint8Array): WorkbookReadResult {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, { type: "array" });
  } catch {
    return { ok: false, missingHeaders: EXPECTED_HEADERS.slice() };
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet) return { ok: false, missingHeaders: EXPECTED_HEADERS.slice() };

  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
  if (grid.length === 0) return { ok: false, missingHeaders: EXPECTED_HEADERS.slice() };

  const headerRow = (grid[0] ?? []).map((cell) => String(cell ?? ""));
  const normalizedHeaderRow = headerRow.map(normalizeText);

  const columnIndex: Partial<Record<ExpectedHeader, number>> = {};
  const missingHeaders: string[] = [];
  for (const expected of EXPECTED_HEADERS) {
    const idx = normalizedHeaderRow.indexOf(normalizeText(expected));
    if (idx === -1) {
      missingHeaders.push(expected);
    } else {
      columnIndex[expected] = idx;
    }
  }
  if (missingHeaders.length > 0) return { ok: false, missingHeaders };

  function cell(row: unknown[], header: ExpectedHeader): unknown {
    const idx = columnIndex[header];
    if (idx === undefined) return "";
    const value = row[idx];
    return value === undefined ? "" : value;
  }
  function cellText(row: unknown[], header: ExpectedHeader): string {
    const value = cell(row, header);
    return value === null || value === undefined ? "" : String(value).trim();
  }

  const rows: RawCorreccionRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i] ?? [];
    const isBlank = row.every((v) => String(v ?? "").trim() === "");
    if (isBlank) continue;
    rows.push({
      fila: i + 1,
      sku: cellText(row, "SKU"),
      producto: cellText(row, "Producto"),
      categoria: cellText(row, "Categoría"),
      tipoProducto: cellText(row, "Tipo de producto"),
      codigoBarras: cellText(row, "Código de barras"),
      gobiernoRaw: cell(row, "Gobierno"),
      representanteRaw: cell(row, "Representante"),
      mayoreoRaw: cell(row, "Mayoreo"),
      medioMayoreoRaw: cell(row, "Medio mayoreo"),
      publicoSugeridoRaw: cell(row, "Público sugerido"),
    });
  }

  return { ok: true, rows };
}

// --- Tipo de producto: lista cerrada (ver TIPOS_PRODUCTO en types.ts) ---

const TIPOS_PRODUCTO_BY_NORMALIZED = new Map(TIPOS_PRODUCTO.map((t) => [normalizeText(t), t]));

// undefined = celda vacía, no se toca el valor existente de la ficha.
// null = trae texto pero no coincide con ningún valor de la lista cerrada.
function resolveTipoProducto(raw: string): string | null | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return TIPOS_PRODUCTO_BY_NORMALIZED.get(normalizeText(trimmed)) ?? null;
}

// --- Precios Venta: Gobierno/Representante/Mayoreo/Medio mayoreo/Publico sugerido ---
// Mismo orden que PRECIOS_VENTA_CATEGORIAS — las 5 columnas del Excel calzan
// 1 a 1 con la lista cerrada de categorías de la tabla precios_venta.
const PRECIO_VENTA_RAW_FIELDS: { field: keyof RawCorreccionRow; categoria: PrecioVentaCategoria }[] = [
  { field: "gobiernoRaw", categoria: PRECIOS_VENTA_CATEGORIAS[0] },
  { field: "representanteRaw", categoria: PRECIOS_VENTA_CATEGORIAS[1] },
  { field: "mayoreoRaw", categoria: PRECIOS_VENTA_CATEGORIAS[2] },
  { field: "medioMayoreoRaw", categoria: PRECIOS_VENTA_CATEGORIAS[3] },
  { field: "publicoSugeridoRaw", categoria: PRECIOS_VENTA_CATEGORIAS[4] },
];

// undefined = celda vacía, no se toca el precio existente de esa categoría.
// null = trae algo pero no es un número válido (>= 0, admite "$"/","/espacios).
function parsePrecioVentaCell(raw: unknown): number | null | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw >= 0 ? raw : null;
  }
  const text = String(raw ?? "").trim();
  if (!text) return undefined;
  const cleaned = text.replace(/[$,\s]/g, "");
  const value = Number(cleaned);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

// --- Clasificación de filas ---

export type CorreccionRowStatus = "valida" | "no_encontrado" | "error";

export interface ClassifiedCorreccionRow extends RawCorreccionRow {
  status: CorreccionRowStatus;
  reason?: string;
  matchedProduct?: Product;
  nombreCambia?: boolean;
  // undefined en cualquiera de estos tres = no tocar ese valor existente de la ficha.
  tipoProductoNuevo?: string;
  codigoBarrasNuevo?: string;
  preciosVenta?: Partial<Record<PrecioVentaCategoria, number>>;
}

// Tope de sanidad, no de calidad de datos — bloquea una celda corrupta, no
// acorta un nombre/categoría legítimos.
const MAX_FIELD_LENGTH = 500;

function fieldTooLong(row: RawCorreccionRow): string | null {
  if (row.sku.length > MAX_FIELD_LENGTH) return "SKU";
  if (row.producto.length > MAX_FIELD_LENGTH) return "Producto";
  if (row.categoria.length > MAX_FIELD_LENGTH) return "Categoría";
  if (row.tipoProducto.length > MAX_FIELD_LENGTH) return "Tipo de producto";
  if (row.codigoBarras.length > MAX_FIELD_LENGTH) return "Código de barras";
  return null;
}

// lookups: SKU (columna) -> ficha existente encontrada por products.codigo
// exacto (null si no existe ninguna) — esta importación nunca crea fichas
// nuevas, solo corrige las que ya existen.
export function classifyCorreccionRows(
  rows: RawCorreccionRow[],
  lookups: Map<number, Product | null>,
): ClassifiedCorreccionRow[] {
  const results: ClassifiedCorreccionRow[] = rows.map((row) => {
    if (!row.sku) return { ...row, status: "error", reason: "Falta el SKU." };
    if (!row.producto) {
      return { ...row, status: "error", reason: "Falta el nombre del producto (columna Producto)." };
    }
    if (!row.categoria) return { ...row, status: "error", reason: "Falta la categoría." };

    const tooLongField = fieldTooLong(row);
    if (tooLongField) {
      return { ...row, status: "error", reason: `La columna "${tooLongField}" excede el largo permitido.` };
    }

    const matched = lookups.get(row.fila) ?? null;
    if (!matched) {
      return {
        ...row,
        status: "no_encontrado",
        reason: "No existe ninguna ficha con este SKU — esta importación no crea fichas nuevas, la fila se omite.",
      };
    }

    const tipoResuelto = resolveTipoProducto(row.tipoProducto);
    if (tipoResuelto === null) {
      return {
        ...row,
        status: "error",
        reason: `Tipo de producto no reconocido: "${row.tipoProducto}".`,
        matchedProduct: matched,
      };
    }

    const precios: Partial<Record<PrecioVentaCategoria, number>> = {};
    const preciosInvalidos: string[] = [];
    for (const { field, categoria } of PRECIO_VENTA_RAW_FIELDS) {
      const parsed = parsePrecioVentaCell(row[field]);
      if (parsed === null) preciosInvalidos.push(categoria);
      else if (parsed !== undefined) precios[categoria] = parsed;
    }
    if (preciosInvalidos.length > 0) {
      return {
        ...row,
        status: "error",
        reason: `Precio inválido en: ${preciosInvalidos.join(", ")}.`,
        matchedProduct: matched,
      };
    }

    const nombreNuevo = row.producto.trim();
    const nombreCambia = nombreNuevo !== matched.nombre.trim();
    const codigoBarrasNuevo = row.codigoBarras.trim() || undefined;

    return {
      ...row,
      status: "valida",
      matchedProduct: matched,
      nombreCambia,
      tipoProductoNuevo: tipoResuelto ?? undefined,
      codigoBarrasNuevo,
      preciosVenta: precios,
      reason: nombreCambia ? `El nombre cambiará: "${matched.nombre}" → "${nombreNuevo}".` : undefined,
    };
  });

  const seenSku = new Map<string, number>();
  for (const row of results) {
    if (row.status === "error" || !row.sku) continue;
    const key = row.sku.toLowerCase();
    const firstFila = seenSku.get(key);
    if (firstFila !== undefined) {
      row.status = "error";
      row.reason = `SKU repetido dentro del archivo — ya aparece en la fila ${firstFila}.`;
      row.matchedProduct = undefined;
      continue;
    }
    seenSku.set(key, row.fila);
  }

  return results;
}
