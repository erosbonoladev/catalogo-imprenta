import * as XLSX from "xlsx";
import type { Product } from "./types";

export const EXPECTED_HEADERS = [
  "Clave",
  "Producto",
  "Categoría",
  "Descripción",
  "Presentación / Contenido",
  "Medidas",
  "Material",
] as const;

type ExpectedHeader = (typeof EXPECTED_HEADERS)[number];

function normalizeHeader(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export interface RawImportRow {
  fila: number;
  clave: string;
  producto: string;
  categoria: string;
  descripcion: string;
  presentacion: string;
  medidas: string;
  material: string;
}

export type WorkbookReadResult =
  | { ok: true; rows: RawImportRow[] }
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
  const normalizedHeaderRow = headerRow.map(normalizeHeader);

  const columnIndex: Partial<Record<ExpectedHeader, number>> = {};
  const missingHeaders: string[] = [];
  for (const expected of EXPECTED_HEADERS) {
    const idx = normalizedHeaderRow.indexOf(normalizeHeader(expected));
    if (idx === -1) {
      missingHeaders.push(expected);
    } else {
      columnIndex[expected] = idx;
    }
  }
  if (missingHeaders.length > 0) return { ok: false, missingHeaders };

  function cell(row: unknown[], header: ExpectedHeader): string {
    const idx = columnIndex[header];
    if (idx === undefined) return "";
    const value = row[idx];
    return value === undefined || value === null ? "" : String(value).trim();
  }

  const rows: RawImportRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i] ?? [];
    const isBlank = row.every((v) => String(v ?? "").trim() === "");
    if (isBlank) continue;
    rows.push({
      fila: i + 1,
      clave: cell(row, "Clave"),
      producto: cell(row, "Producto"),
      categoria: cell(row, "Categoría"),
      descripcion: cell(row, "Descripción"),
      presentacion: cell(row, "Presentación / Contenido"),
      medidas: cell(row, "Medidas"),
      material: cell(row, "Material"),
    });
  }

  return { ok: true, rows };
}

// --- Presentación / Contenido -> especificaciones estructuradas ---

const UNIT_RE = /\b(cm|mm|kg|gr|gramos?|pulgadas?|plg|in|m|g)\b|"|°/i;
const LEADING_QTY_RE = /^(\d+(?:[.,]\d+)?)\s*/;
const BOUNDARY_RE = /\d+(?:[.,]\d+)?\s+(?=[A-ZÁÉÍÓÚÑ])/g;

function splitLineByQuantityBoundaries(line: string): string[] {
  const starts: number[] = [];
  let match: RegExpExecArray | null;
  BOUNDARY_RE.lastIndex = 0;
  while ((match = BOUNDARY_RE.exec(line))) starts.push(match.index);

  if (starts.length === 0) {
    const trimmed = line.trim();
    return trimmed ? [trimmed] : [];
  }

  const chunks: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const begin = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : line.length;
    const chunk = line.slice(begin, end).trim();
    if (chunk) chunks.push(chunk);
  }
  if (starts[0] > 0 && chunks.length > 0) {
    const before = line.slice(0, starts[0]).trim();
    if (before) chunks[0] = `${before} ${chunks[0]}`.trim();
  }
  return chunks;
}

function splitPresentacionItems(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  const hasExplicitSeparators = /\n|;/.test(normalized);
  const candidateLines = hasExplicitSeparators
    ? normalized
        .split(/\n|;/g)
        .map((s) => s.replace(/^[\s•·▪*-]+/, "").trim())
        .filter(Boolean)
    : [normalized];

  return candidateLines.flatMap(splitLineByQuantityBoundaries);
}

function parseItem(rawChunk: string): { etiqueta: string; valor: string } | null {
  const chunk = rawChunk.replace(/^[\s•·▪*-]+/, "").trim();
  if (!chunk) return null;

  const qtyMatch = chunk.match(LEADING_QTY_RE);
  if (!qtyMatch) {
    return { etiqueta: "Presentación / Contenido", valor: chunk };
  }

  const cantidad = qtyMatch[1];
  const rest = chunk
    .slice(qtyMatch[0].length)
    .trim()
    .replace(/\.+$/, "")
    .trim();
  if (!rest) return { etiqueta: chunk, valor: cantidad };

  const digitIdx = rest.search(/\d/);
  const hasMeasurement = digitIdx !== -1 && UNIT_RE.test(rest.slice(digitIdx));

  if (hasMeasurement) {
    const nombre = rest
      .slice(0, digitIdx)
      .trim()
      .replace(/\bde\s*$/i, "")
      .trim();
    const valor = rest
      .slice(digitIdx)
      .trim()
      .replace(/\bdiam\.?\b/gi, "diámetro")
      // Un punto seguido de espacio a mitad de frase es una abreviación (ej. "cm."), no un
      // separador decimal (esos van pegados, ej. "2.8") — se limpia para no dejarlo suelto.
      .replace(/\.\s+/g, " ")
      .replace(/\s{2,}/g, " ")
      .replace(/\.+$/, "")
      .trim();
    return { etiqueta: nombre ? `${cantidad} ${nombre}` : cantidad, valor };
  }

  return { etiqueta: rest, valor: cantidad };
}

export function parsePresentacionContenido(raw: string): { etiqueta: string; valor: string }[] {
  const text = raw.trim();
  if (!text) return [];

  const chunks = splitPresentacionItems(text);
  const specs: { etiqueta: string; valor: string }[] = [];
  for (const chunk of chunks) {
    const parsed = parseItem(chunk);
    if (parsed && parsed.etiqueta && parsed.valor) specs.push(parsed);
  }

  if (specs.length === 0) {
    return [{ etiqueta: "Presentación / Contenido", valor: text }];
  }
  return specs;
}

export function buildSpecsForRow(
  row: Pick<RawImportRow, "medidas" | "presentacion">,
): { etiqueta: string; valor: string }[] {
  const specs: { etiqueta: string; valor: string }[] = [];
  if (row.medidas.trim()) {
    specs.push({ etiqueta: "Medidas", valor: row.medidas.trim() });
  }
  specs.push(...parsePresentacionContenido(row.presentacion));
  return specs;
}

// --- Clasificación de filas y detección de duplicados ---

export type RowStatus = "nueva" | "duplicada" | "error";

export interface ClassifiedRow extends RawImportRow {
  status: RowStatus;
  reason?: string;
  matchedProduct?: Product;
}

export interface RowLookup {
  byCodigo: Product | null;
  byNombre: Product[];
}

// Topes de sanidad, no de calidad de datos — solo bloquean una celda
// corrupta/pegada por accidente con miles de caracteres, no acortan
// descripciones legítimas.
const MAX_SHORT_FIELD_LENGTH = 500;
const MAX_LONG_FIELD_LENGTH = 10_000;

function fieldTooLong(row: RawImportRow): string | null {
  if (row.clave.length > MAX_SHORT_FIELD_LENGTH) return "Clave";
  if (row.producto.length > MAX_SHORT_FIELD_LENGTH) return "Producto";
  if (row.categoria.length > MAX_SHORT_FIELD_LENGTH) return "Categoría";
  if (row.material.length > MAX_SHORT_FIELD_LENGTH) return "Material";
  if (row.descripcion.length > MAX_LONG_FIELD_LENGTH) return "Descripción";
  if (row.presentacion.length > MAX_LONG_FIELD_LENGTH) return "Presentación / Contenido";
  if (row.medidas.length > MAX_LONG_FIELD_LENGTH) return "Medidas";
  return null;
}

export function classifyRows(
  rows: RawImportRow[],
  lookups: Map<number, RowLookup>,
): ClassifiedRow[] {
  const results: ClassifiedRow[] = rows.map((row) => {
    if (!row.producto) {
      return { ...row, status: "error", reason: "Falta el nombre del producto (columna Producto)." };
    }

    const tooLongField = fieldTooLong(row);
    if (tooLongField) {
      return { ...row, status: "error", reason: `La columna "${tooLongField}" excede el largo permitido.` };
    }

    const lookup = lookups.get(row.fila) ?? { byCodigo: null, byNombre: [] };

    // La Clave manda cuando coincide con un código existente.
    if (lookup.byCodigo) {
      return { ...row, status: "duplicada", matchedProduct: lookup.byCodigo };
    }

    // Sin coincidencia por código (o sin Clave): se busca por nombre — esto aplica
    // siempre, no solo cuando falta la Clave, para detectar una ficha ya existente
    // con el mismo nombre aunque la fila traiga una Clave nueva/distinta.
    if (lookup.byNombre.length > 1) {
      return {
        ...row,
        status: "error",
        reason:
          "Se encontraron varios productos existentes con este nombre; corrige o agrega la Clave para identificar cuál actualizar.",
      };
    }
    if (lookup.byNombre.length === 1) {
      return { ...row, status: "duplicada", matchedProduct: lookup.byNombre[0] };
    }

    // Sin coincidencia por código ni por nombre.
    if (row.clave) {
      return { ...row, status: "nueva" };
    }
    return {
      ...row,
      status: "error",
      reason: "Falta la Clave y no se encontró una ficha existente con este nombre para actualizar.",
    };
  });

  const seenClave = new Map<string, number>();
  const seenNombreSinClave = new Map<string, number>();
  const seenMatchedId = new Map<number, number>();
  for (const row of results) {
    if (row.status === "error") continue;
    if (row.clave) {
      const key = row.clave.toLowerCase();
      const firstFila = seenClave.get(key);
      if (firstFila !== undefined) {
        row.status = "error";
        row.reason = `Clave repetida dentro del archivo — ya aparece en la fila ${firstFila}.`;
        row.matchedProduct = undefined;
        continue;
      }
      seenClave.set(key, row.fila);
    } else if (row.status !== "duplicada") {
      const key = row.producto.toLowerCase();
      const firstFila = seenNombreSinClave.get(key);
      if (firstFila !== undefined) {
        row.status = "error";
        row.reason = `Producto repetido dentro del archivo (sin Clave) — ya aparece en la fila ${firstFila}.`;
        row.matchedProduct = undefined;
        continue;
      }
      seenNombreSinClave.set(key, row.fila);
    }

    // Dos filas distintas (con Claves distintas, o una con Clave y otra sin ella)
    // que terminan apuntando a la misma ficha existente por nombre.
    if (row.status === "duplicada" && row.matchedProduct) {
      const firstFila = seenMatchedId.get(row.matchedProduct.id);
      if (firstFila !== undefined) {
        row.status = "error";
        row.reason = `Esta fila coincide con la misma ficha existente que la fila ${firstFila} — revísalas por separado.`;
        row.matchedProduct = undefined;
      } else {
        seenMatchedId.set(row.matchedProduct.id, row.fila);
      }
    }
  }

  return results;
}
