import * as XLSX from "xlsx";

// SKU con letras adicionales (8059C, 8059D) se agrupan bajo su SKU principal
// quitando las letras finales — sin verificar que ese SKU base exista como
// producto real (8059C puede ser un precio relacionado sin ficha propia).
const TRAILING_LETTERS_RE = /[A-Za-z]+$/;

export function computeSkuPrincipal(sku: string): string {
  const trimmed = sku.trim();
  const stripped = trimmed.replace(TRAILING_LETTERS_RE, "");
  return stripped || trimmed;
}

export const EXPECTED_HEADERS = ["SKU", "Nombre", "Precio", "Fecha de actualización"] as const;
type ExpectedHeader = (typeof EXPECTED_HEADERS)[number];

function normalizeHeader(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export interface RawPrecioRow {
  fila: number;
  sku: string;
  nombre: string;
  precioRaw: unknown;
  fechaRaw: unknown;
}

export type PrecioWorkbookReadResult =
  | { ok: true; rows: RawPrecioRow[] }
  | { ok: false; missingHeaders: string[] };

export function readPreciosWorkbook(bytes: Uint8Array): PrecioWorkbookReadResult {
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

  function cell(row: unknown[], header: ExpectedHeader): unknown {
    const idx = columnIndex[header];
    if (idx === undefined) return "";
    const value = row[idx];
    return value === undefined ? "" : value;
  }

  const rows: RawPrecioRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i] ?? [];
    const isBlank = row.every((v) => String(v ?? "").trim() === "");
    if (isBlank) continue;
    rows.push({
      fila: i + 1,
      sku: String(cell(row, "SKU") ?? "").trim(),
      nombre: String(cell(row, "Nombre") ?? "").trim(),
      precioRaw: cell(row, "Precio"),
      fechaRaw: cell(row, "Fecha de actualización"),
    });
  }

  return { ok: true, rows };
}

// Excel guarda fechas como número serial (días desde 1899-12-30) cuando la
// celda tiene formato de fecha, o como texto si no lo tiene — hay que cubrir
// ambos casos.
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const DDMMYYYY_RE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/;
// Acepta también fecha+hora ISO 8601 completa (ej. 2026-07-13T15:48:42.128Z,
// tal como la exporta Excel/JS al formatear la celda como datetime) — solo
// se usa la parte de fecha, la hora se descarta.
const YYYYMMDD_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/;

// Date.UTC normaliza silenciosamente días fuera de rango (31/04 -> 1/05) en
// vez de fallar, así que hay que verificar que el año/mes/día resultante
// coincida con lo que se pidió — si no, era una fecha inválida disfrazada.
function buildAndValidateDate(y: number, m: number, d: number): { ok: true; iso: string } | { ok: false } {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return { ok: false };
  }
  return { ok: true, iso: date.toISOString().slice(0, 10) };
}

export function parseFechaExcel(raw: unknown): { ok: true; iso: string } | { ok: false } {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const date = new Date(EXCEL_EPOCH_MS + raw * 86_400_000);
    if (Number.isNaN(date.getTime())) return { ok: false };
    return { ok: true, iso: date.toISOString().slice(0, 10) };
  }

  const text = String(raw ?? "").trim();
  if (!text) return { ok: false };

  const ddmmyyyy = text.match(DDMMYYYY_RE);
  if (ddmmyyyy) {
    const [, d, m, yRaw] = ddmmyyyy;
    const y = yRaw.length === 2 ? `20${yRaw}` : yRaw;
    return buildAndValidateDate(Number(y), Number(m), Number(d));
  }

  const yyyymmdd = text.match(YYYYMMDD_RE);
  if (yyyymmdd) {
    const [, y, m, d] = yyyymmdd;
    return buildAndValidateDate(Number(y), Number(m), Number(d));
  }

  return { ok: false };
}

export function parsePrecioValor(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw > 0 ? raw : null;
  const text = String(raw ?? "")
    .trim()
    .replace(/[$,\s]/g, "");
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export type PrecioRowStatus = "valido" | "no_encontrado" | "error";

export interface ClassifiedPrecioRow extends RawPrecioRow {
  status: PrecioRowStatus;
  reason?: string;
  precio?: number;
  fechaIso?: string;
  skuPrincipal?: string;
}

export function classifyPrecioRows(
  rows: RawPrecioRow[],
  productExists: Map<string, boolean>,
): ClassifiedPrecioRow[] {
  const results: ClassifiedPrecioRow[] = rows.map((row) => {
    if (!row.sku) {
      return { ...row, status: "error", reason: "Falta el SKU." };
    }
    if (!row.nombre) {
      return { ...row, status: "error", reason: "Falta el nombre." };
    }
    const precio = parsePrecioValor(row.precioRaw);
    if (precio === null) {
      return { ...row, status: "error", reason: "Precio inválido — debe ser un número mayor que 0." };
    }
    const fecha = parseFechaExcel(row.fechaRaw);
    if (!fecha.ok) {
      return { ...row, status: "error", reason: "Fecha de actualización inválida." };
    }

    const skuPrincipal = computeSkuPrincipal(row.sku);
    const encontrado = productExists.get(skuPrincipal.toLowerCase()) ?? false;
    return {
      ...row,
      status: encontrado ? "valido" : "no_encontrado",
      precio,
      fechaIso: fecha.iso,
      skuPrincipal,
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
      continue;
    }
    seenSku.set(key, row.fila);
  }

  return results;
}
