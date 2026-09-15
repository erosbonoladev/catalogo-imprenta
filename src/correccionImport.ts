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

type PrecioVentaCellResult =
  | { kind: "vacia" }
  | { kind: "valor"; valor: number }
  | { kind: "por_definir" }
  | { kind: "invalido" };

const POR_DEFINIR_NORMALIZADO = normalizeText("Por definir");

// vacia = celda vacía, no se toca el precio existente de esa categoría.
// por_definir = el Excel trae literalmente "Por definir" — se guarda
// explícitamente sin precio (NULL en precios_venta, igual que dejarlo en
// blanco a mano desde PreciosVentaModal), a diferencia de "vacia" que
// preserva lo que ya hubiera.
// invalido = trae algo que no es ni un número (>= 0, admite "$"/","/espacios)
// ni "Por definir".
function parsePrecioVentaCell(raw: unknown): PrecioVentaCellResult {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw >= 0 ? { kind: "valor", valor: raw } : { kind: "invalido" };
  }
  const text = String(raw ?? "").trim();
  if (!text) return { kind: "vacia" };
  if (normalizeText(text) === POR_DEFINIR_NORMALIZADO) return { kind: "por_definir" };
  const cleaned = text.replace(/[$,\s]/g, "");
  const value = Number(cleaned);
  return Number.isFinite(value) && value >= 0 ? { kind: "valor", valor: value } : { kind: "invalido" };
}

// --- Clasificación de filas ---

// actualiza = ya existe una ficha con ese SKU, se corrige.
// crea = no existe ninguna ficha con ese SKU — a diferencia de antes, esta
// importación ahora también da de alta fichas nuevas con lo que trae el
// Excel (SKU/Producto/Categoría/Tipo de producto/Código de barras/Precios
// Venta); material, descripción, specs e imagen quedan vacíos/sin asignar,
// igual que un alta manual en blanco desde ProductForm.
export type CorreccionRowStatus = "actualiza" | "crea" | "error";

export interface ClassifiedCorreccionRow extends RawCorreccionRow {
  status: CorreccionRowStatus;
  reason?: string;
  matchedProduct?: Product;
  // true = el Excel trae un nombre distinto al de la ficha. Solo marca/notifica
  // — no decide si se aplica: CorreccionImportPanel exige aceptarlo fila por
  // fila (o "Marcar todos") antes de confirmar, por defecto se mantiene el
  // nombre actual.
  nombreCambia?: boolean;
  // undefined en tipoProductoNuevo/codigoBarrasNuevo = no tocar ese valor
  // existente de la ficha (solo tiene sentido para status "actualiza"; para
  // "crea" el panel de importación los trata como "" — no hay valor previo
  // que preservar).
  tipoProductoNuevo?: string;
  codigoBarrasNuevo?: string;
  // undefined en una categoría = no tocar el precio existente de esa
  // categoría (o, si es alta nueva, no crear fila en precios_venta para
  // ella). null = "Por definir" en el Excel, se guarda explícitamente sin
  // precio.
  preciosVenta?: Partial<Record<PrecioVentaCategoria, number | null>>;
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
// exacto (null si no existe ninguna). Si no existe, la fila da de alta una
// ficha nueva en vez de omitirse (ver CorreccionRowStatus).
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

    const tipoResuelto = resolveTipoProducto(row.tipoProducto);
    if (tipoResuelto === null) {
      return {
        ...row,
        status: "error",
        reason: `Tipo de producto no reconocido: "${row.tipoProducto}".`,
        matchedProduct: matched ?? undefined,
      };
    }

    const precios: Partial<Record<PrecioVentaCategoria, number | null>> = {};
    const preciosInvalidos: string[] = [];
    for (const { field, categoria } of PRECIO_VENTA_RAW_FIELDS) {
      const parsed = parsePrecioVentaCell(row[field]);
      if (parsed.kind === "invalido") preciosInvalidos.push(categoria);
      else if (parsed.kind === "valor") precios[categoria] = parsed.valor;
      else if (parsed.kind === "por_definir") precios[categoria] = null;
    }
    if (preciosInvalidos.length > 0) {
      return {
        ...row,
        status: "error",
        reason: `Precio inválido en: ${preciosInvalidos.join(", ")}.`,
        matchedProduct: matched ?? undefined,
      };
    }

    const codigoBarrasNuevo = row.codigoBarras.trim() || undefined;

    if (!matched) {
      return {
        ...row,
        status: "crea",
        tipoProductoNuevo: tipoResuelto ?? undefined,
        codigoBarrasNuevo,
        preciosVenta: precios,
      };
    }

    const nombreNuevo = row.producto.trim();
    const nombreCambia = nombreNuevo !== matched.nombre.trim();

    return {
      ...row,
      status: "actualiza",
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
