import * as XLSX from "xlsx";
import type { Product, WoodProduct, WoodProductInput } from "./types";
import { parseAmount } from "./precios";

function normalizeHeader(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export interface RawMaderaImportRow {
  fila: number;
  nombre: string;
  sku: string;
  tamano: string;
  capas: string;
  largo: string;
  ancho: string;
  espesor: string;
  cabenHojaMdf: string;
  minutosLaser: string;
  importeMadera: string;
  pintura: string;
  importeCorteLaser: string;
  etiquetaAdhesiva: string;
  otroImporte: string;
  otroConcepto: string;
  etiquetaEmpaque: string;
  costoTotal: string;
  precioVenta: string;
}

type ColumnKey =
  | "nombre"
  | "sku"
  | "tamano"
  | "capas"
  | "largo"
  | "ancho"
  | "espesor"
  | "cabenHojaMdf"
  | "minutosLaser"
  | "importeMadera"
  | "pintura"
  | "importeCorteLaser"
  | "etiquetaAdhesiva"
  | "otroImporte"
  | "otroConcepto"
  | "etiquetaEmpaque"
  | "costoTotal"
  | "precioVenta";

interface ColumnSpec {
  key: ColumnKey;
  label: string;
  tokens: string[];
  exclude?: string[];
}

// Encabezados reales del archivo del usuario ("Precios Madera Abril 26.xlsx")
// traen inconsistencias de redacción/typos ("cabenen" en vez de "caben",
// "lasser" en vez de "laser", "capas" en minúsculas) — igual que
// piezasImport.ts, el match es por tokens contenidos en el encabezado
// normalizado, no por igualdad exacta. El archivo real también trae una
// segunda columna "espesor de la madera en mm" (duplicado numérico de
// "espesor de la madera", ignorado — ver `exclude`) y, al final, 5 columnas
// más ("QUE ES OTRO" aparte, "INSTRUCTIVO", "PRODUCTO", "CLAVE", "PRECIO")
// que son un espejo de las columnas principales para otro uso del archivo,
// con inconsistencias frente a las columnas reales (confirmado comparando
// las 88 filas: 14 no coinciden) — se ignoran todas excepto "QUE ES OTRO",
// que sí es la descripción/concepto de "Otro" (confirmado con datos reales:
// fila "Alfabeto Pesca Madera" trae Otro=8 junto con
// QUE ES OTRO="imán y armado $ 16.50").
const COLUMN_SPECS: ColumnSpec[] = [
  { key: "nombre", label: "Producto", tokens: ["producto"] },
  { key: "sku", label: "SKU", tokens: ["sku"] },
  { key: "tamano", label: "Tamaño", tokens: ["tamano"] },
  { key: "capas", label: "Capas", tokens: ["capas"] },
  { key: "largo", label: "Largo", tokens: ["largo"] },
  { key: "ancho", label: "Ancho", tokens: ["ancho"] },
  { key: "espesor", label: "Espesor de la madera", tokens: ["espesor"], exclude: ["mm"] },
  {
    key: "cabenHojaMdf",
    label: "Caben en una hoja de MDF 122 x 244",
    tokens: ["caben", "hoja", "mdf"],
  },
  { key: "minutosLaser", label: "Minutos en láser", tokens: ["minutos", "laser"] },
  { key: "importeMadera", label: "Importe madera", tokens: ["importe", "madera"] },
  { key: "pintura", label: "Pintura", tokens: ["pintura"] },
  { key: "importeCorteLaser", label: "Importe corte láser", tokens: ["importe", "corte"] },
  { key: "etiquetaAdhesiva", label: "Etiqueta adhesiva", tokens: ["etiqueta", "adhesiva"] },
  { key: "otroImporte", label: "Otro", tokens: ["otro"], exclude: ["que"] },
  { key: "otroConcepto", label: "Qué es Otro", tokens: ["que", "es", "otro"] },
  { key: "etiquetaEmpaque", label: "Etiqueta empaque", tokens: ["etiqueta", "empaque"] },
  { key: "costoTotal", label: "Costo total", tokens: ["costo", "total"] },
  { key: "precioVenta", label: "Precio venta", tokens: ["precio", "venta"] },
];

function findColumn(normalizedHeaderRow: string[], spec: ColumnSpec): number {
  return normalizedHeaderRow.findIndex((h) => {
    if (!spec.tokens.every((token) => h.includes(token))) return false;
    if (spec.exclude?.some((token) => h.includes(token))) return false;
    return true;
  });
}

export type MaderaWorkbookReadResult =
  | { ok: true; rows: RawMaderaImportRow[] }
  | { ok: false; missingHeaders: string[] };

const ALL_LABELS = COLUMN_SPECS.map((s) => s.label);

export function readMaderaWorkbook(bytes: Uint8Array): MaderaWorkbookReadResult {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, { type: "array" });
  } catch {
    return { ok: false, missingHeaders: ALL_LABELS.slice() };
  }

  // El archivo real trae una segunda hoja ("Hoja1") con un cálculo derivado
  // de % de aprovechamiento de madera para requisición — no son productos,
  // se ignora igual que se ignoran columnas irrelevantes en otras
  // importaciones. Solo se lee la primera hoja.
  const sheetName = workbook.SheetNames[0];
  const maybeSheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!maybeSheet) return { ok: false, missingHeaders: ALL_LABELS.slice() };
  const sheet: XLSX.WorkSheet = maybeSheet;

  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
  if (grid.length === 0) return { ok: false, missingHeaders: ALL_LABELS.slice() };

  const headerRow = (grid[0] ?? []).map((cell) => String(cell ?? ""));
  const normalizedHeaderRow = headerRow.map(normalizeHeader);

  const columnIndex: Partial<Record<ColumnKey, number>> = {};
  const missingHeaders: string[] = [];
  for (const spec of COLUMN_SPECS) {
    const idx = findColumn(normalizedHeaderRow, spec);
    if (idx === -1) {
      missingHeaders.push(spec.label);
    } else {
      columnIndex[spec.key] = idx;
    }
  }
  if (missingHeaders.length > 0) return { ok: false, missingHeaders };

  function cell(row: unknown[], key: ColumnKey): string {
    const idx = columnIndex[key];
    if (idx === undefined) return "";
    const value = row[idx];
    return value === undefined || value === null ? "" : String(value).trim();
  }

  const rows: RawMaderaImportRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i] ?? [];
    const isBlank = row.every((v) => String(v ?? "").trim() === "");
    if (isBlank) continue;

    rows.push({
      fila: i + 1,
      nombre: cell(row, "nombre"),
      sku: cell(row, "sku"),
      tamano: cell(row, "tamano"),
      capas: cell(row, "capas"),
      largo: cell(row, "largo"),
      ancho: cell(row, "ancho"),
      espesor: cell(row, "espesor"),
      cabenHojaMdf: cell(row, "cabenHojaMdf"),
      minutosLaser: cell(row, "minutosLaser"),
      importeMadera: cell(row, "importeMadera"),
      pintura: cell(row, "pintura"),
      importeCorteLaser: cell(row, "importeCorteLaser"),
      etiquetaAdhesiva: cell(row, "etiquetaAdhesiva"),
      otroImporte: cell(row, "otroImporte"),
      otroConcepto: cell(row, "otroConcepto"),
      etiquetaEmpaque: cell(row, "etiquetaEmpaque"),
      costoTotal: cell(row, "costoTotal"),
      precioVenta: cell(row, "precioVenta"),
    });
  }

  return { ok: true, rows };
}

// --- Parseo de campos monetarios ---
//
// A diferencia de Tamaño/Capas/Largo/Ancho/Espesor (texto libre, se
// conservan tal cual vienen — confirmado con un caso real de Espesor
// combinado "5.5 y 2.5" que no es un solo número), los campos de dinero SÍ
// deben tratarse como números (pedido explícito del usuario). Vacío -> sin
// valor (null, no se inventa 0). Con contenido que no es un número válido
// (confirmado en el archivo real: 9 filas de piezas "Caja"/"tablero" traen
// texto suelto en Precio venta en vez de un precio) -> inválido, la fila se
// marca "error" en vez de perder o adivinar el dato.
export interface MoneyFieldResult {
  ok: boolean;
  value: number | null;
}

export function parseMoneyField(raw: string): MoneyFieldResult {
  if (raw.trim() === "") return { ok: true, value: null };
  const parsed = parseAmount(raw);
  if (parsed === null) return { ok: false, value: null };
  return { ok: true, value: parsed };
}

const MONEY_FIELDS: { key: keyof RawMaderaImportRow; label: string }[] = [
  { key: "importeMadera", label: "Importe madera" },
  { key: "pintura", label: "Pintura" },
  { key: "importeCorteLaser", label: "Importe corte láser" },
  { key: "etiquetaAdhesiva", label: "Etiqueta adhesiva" },
  { key: "otroImporte", label: "Otro" },
  { key: "etiquetaEmpaque", label: "Etiqueta empaque" },
  { key: "costoTotal", label: "Costo total" },
  { key: "precioVenta", label: "Precio venta" },
];

// --- Clasificación de filas ---

export type MaderaRowStatus = "nueva" | "actualizar" | "sin-relacion" | "error";

export interface ClassifiedMaderaRow extends RawMaderaImportRow {
  status: MaderaRowStatus;
  reason?: string;
  matchedJuego?: Product;
  matchedWoodProduct?: WoodProduct;
}

export interface MaderaRowLookup {
  juego: Product | null;
  wood: WoodProduct | null;
}

export const SIN_SKU_MOTIVO =
  "Esta fila no trae SKU — no se puede determinar a qué producto/juego pertenece";
export const SIN_RELACION_MOTIVO = "El SKU no corresponde a ningún producto/juego existente";

// Topes de sanidad, no de calidad de datos — solo bloquean una celda
// corrupta/pegada por accidente con miles de caracteres (mismo criterio que
// piezasImport.ts).
const MAX_SHORT_FIELD_LENGTH = 500;
const MAX_LONG_FIELD_LENGTH = 10_000;

function fieldTooLong(row: RawMaderaImportRow): string | null {
  if (row.nombre.length > MAX_SHORT_FIELD_LENGTH) return "Producto";
  if (row.sku.length > MAX_SHORT_FIELD_LENGTH) return "SKU";
  if (row.tamano.length > MAX_SHORT_FIELD_LENGTH) return "Tamaño";
  if (row.capas.length > MAX_SHORT_FIELD_LENGTH) return "Capas";
  if (row.largo.length > MAX_SHORT_FIELD_LENGTH) return "Largo";
  if (row.ancho.length > MAX_SHORT_FIELD_LENGTH) return "Ancho";
  if (row.espesor.length > MAX_SHORT_FIELD_LENGTH) return "Espesor de la madera";
  if (row.cabenHojaMdf.length > MAX_SHORT_FIELD_LENGTH) return "Caben en una hoja de MDF 122 x 244";
  if (row.minutosLaser.length > MAX_SHORT_FIELD_LENGTH) return "Minutos en láser";
  if (row.otroConcepto.length > MAX_LONG_FIELD_LENGTH) return "Qué es Otro";
  return null;
}

export function classifyMaderaRows(
  rows: RawMaderaImportRow[],
  lookups: Map<number, MaderaRowLookup>,
): ClassifiedMaderaRow[] {
  const results: ClassifiedMaderaRow[] = rows.map((row) => {
    if (!row.nombre.trim()) {
      return { ...row, status: "error", reason: "Falta el Producto." };
    }

    const tooLongField = fieldTooLong(row);
    if (tooLongField) {
      return { ...row, status: "error", reason: `La columna "${tooLongField}" excede el largo permitido.` };
    }

    for (const { key, label } of MONEY_FIELDS) {
      const raw = row[key] as string;
      if (!parseMoneyField(raw).ok) {
        return {
          ...row,
          status: "error",
          reason: `La columna "${label}" no es un valor numérico válido: "${raw}".`,
        };
      }
    }

    if (!row.sku.trim()) {
      return { ...row, status: "sin-relacion", reason: SIN_SKU_MOTIVO };
    }

    const matchedJuego = lookups.get(row.fila)?.juego ?? null;
    if (!matchedJuego) {
      return { ...row, status: "sin-relacion", reason: SIN_RELACION_MOTIVO };
    }

    const matchedWoodProduct = lookups.get(row.fila)?.wood ?? undefined;
    if (matchedWoodProduct) {
      return { ...row, status: "actualizar", matchedJuego, matchedWoodProduct };
    }
    return { ...row, status: "nueva", matchedJuego };
  });

  // Duplicado dentro del mismo archivo: mismo juego + mismo nombre + mismo
  // tamaño. A diferencia de Piezas, el SKU no sirve como discriminante aquí
  // porque identifica al juego (se repite a propósito en varias filas
  // cuando un juego tiene varias piezas de madera — confirmado con datos
  // reales, ej. SKU 4054 aparece dos veces con Tamaño distinto para dos
  // piezas de láser distintas del mismo juego). Nombre solo tampoco alcanza
  // (mismo caso: mismo Producto, Tamaño distinto = piezas distintas), así
  // que la clave real de una fila dentro de su juego es nombre+tamaño.
  const seenPorJuego = new Map<string, number>();
  for (const row of results) {
    if (row.status !== "nueva" && row.status !== "actualizar") continue;
    if (!row.matchedJuego) continue;
    const key = `${row.matchedJuego.id}::${row.nombre.trim().toLowerCase()}::${row.tamano.trim().toLowerCase()}`;
    const firstFila = seenPorJuego.get(key);
    if (firstFila !== undefined) {
      row.status = "error";
      row.reason = `Fila duplicada dentro del mismo juego en este archivo — ya aparece en la fila ${firstFila}.`;
      row.matchedWoodProduct = undefined;
      continue;
    }
    seenPorJuego.set(key, row.fila);
  }

  return results;
}

// Construye el WoodProductInput a escribir para una fila ya clasificada. A
// diferencia de Piezas (buildPiezaInput), casi no hay campos a preservar de
// un registro existente en una actualización: el Excel de Maderas trae
// todas sus columnas siempre, así que una actualización reemplaza por
// completo con lo que traiga la fila — incluidos los campos que vengan
// vacíos (ej. Pintura vacía significa "esta pieza no lleva pintura", no "no
// tenemos ese dato"). La única excepción es `imagen`: el Excel no trae
// fotos (se agregan a mano desde MaderasSection), así que una actualización
// preserva la que ya tuviera el registro en vez de borrarla.
export function buildMaderaInput(row: ClassifiedMaderaRow): WoodProductInput {
  return {
    nombre: row.nombre.trim(),
    sku: row.sku.trim(),
    tamano: row.tamano.trim(),
    capas: row.capas.trim(),
    largo: row.largo.trim(),
    ancho: row.ancho.trim(),
    espesor: row.espesor.trim(),
    caben_hoja_mdf: row.cabenHojaMdf.trim(),
    minutos_laser: row.minutosLaser.trim(),
    importe_madera: parseMoneyField(row.importeMadera).value,
    pintura: parseMoneyField(row.pintura).value,
    importe_corte_laser: parseMoneyField(row.importeCorteLaser).value,
    etiqueta_adhesiva: parseMoneyField(row.etiquetaAdhesiva).value,
    otro_importe: parseMoneyField(row.otroImporte).value,
    otro_concepto: row.otroConcepto.trim(),
    etiqueta_empaque: parseMoneyField(row.etiquetaEmpaque).value,
    costo_total: parseMoneyField(row.costoTotal).value,
    precio_venta: parseMoneyField(row.precioVenta).value,
    imagen: row.matchedWoodProduct?.imagen ?? null,
  };
}
