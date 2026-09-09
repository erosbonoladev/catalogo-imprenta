import * as XLSX from "xlsx";
import type { ImageBlob, PlasticProduct, PlasticProductInput, Product } from "./types";

function normalizeHeader(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export interface RawPiezaImportRow {
  fila: number;
  // SKU del juego al que pertenece esta pieza — no viene en una columna
  // propia de la fila, se resuelve agrupando por bloques (ver
  // readPiezasWorkbook): una fila con SKU sin guion es un juego, y las
  // filas siguientes (sin SKU, o con SKU con guion) son sus piezas, hasta
  // el próximo juego. Vacío si esta fila apareció antes de cualquier fila
  // de juego.
  juegoSku: string;
  // SKU propio de la pieza, si la empresa le asignó uno (ej. "1138-1",
  // sub-SKU del juego; o "3346-17", una pieza reutilizada de otro
  // contexto) — vacío cuando la pieza no tiene SKU propio, que también es
  // válido y común en este formato.
  sku: string;
  origen: string;
  descripcion: string;
  componentesFabricacion: string;
  dimension: string;
  peso: string;
  maquila: string;
  coste: string;
  dimensionesEmpaque: string;
  linkImagen: string;
}

type ColumnKey = "origen" | "sku" | "descripcion" | "componentesFabricacion" | "dimension" | "peso" | "maquila" | "coste" | "dimensionesEmpaque" | "linkImagen";

interface ColumnSpec {
  key: ColumnKey;
  label: string;
  // Todos estos tokens (normalizados) deben aparecer en el encabezado.
  tokens: string[];
  // Si aparece cualquiera de estos, el encabezado NO es de esta columna —
  // usado para distinguir "Dimensiones (CM)" de "Dimensiones Empaque".
  exclude?: string[];
}

// Encabezados reales del archivo del usuario traen unidades entre paréntesis
// ("PESO (GR.)") y variantes de redacción ("COMPONENTES FABRICACION"/"...DE
// FABRICACION") — por eso el match es por tokens contenidos, no por
// igualdad exacta como en fichaImport.ts. La columna "IMAGEN" (miniatura,
// primera columna del archivo real) y "NETO PROD" se ignoran deliberadamente
// — no se importan ni se guardan en ningún lado.
const COLUMN_SPECS: ColumnSpec[] = [
  { key: "origen", label: "Origen", tokens: ["origen"] },
  { key: "sku", label: "SKU", tokens: ["sku"] },
  { key: "descripcion", label: "Descripción", tokens: ["descripcion"] },
  {
    key: "componentesFabricacion",
    label: "Componentes de Fabricación",
    tokens: ["componentes", "fabricacion"],
  },
  { key: "dimension", label: "Dimensiones", tokens: ["dimension"], exclude: ["empaque"] },
  { key: "peso", label: "Peso", tokens: ["peso"] },
  { key: "maquila", label: "Maquila", tokens: ["maquila"] },
  { key: "coste", label: "Costo", tokens: ["costo"] },
  { key: "dimensionesEmpaque", label: "Dimensiones Empaque", tokens: ["dimension", "empaque"] },
  { key: "linkImagen", label: "Links Imágenes Piezas", tokens: ["link"] },
];

function findColumn(normalizedHeaderRow: string[], spec: ColumnSpec): number {
  return normalizedHeaderRow.findIndex((h) => {
    if (!spec.tokens.every((token) => h.includes(token))) return false;
    if (spec.exclude?.some((token) => h.includes(token))) return false;
    return true;
  });
}

export type PiezasWorkbookReadResult =
  | { ok: true; rows: RawPiezaImportRow[] }
  | { ok: false; missingHeaders: string[] };

const ALL_LABELS = COLUMN_SPECS.map((s) => s.label);

// El archivo usa celdas combinadas de Excel para mostrar un valor una sola
// vez a lo largo de todas las piezas de un juego (ej. Maquila "$5.00"
// fusionada verticalmente en vez de repetida en cada fila) — sheet_to_json
// solo devuelve el valor en la celda ancla (arriba-izquierda) del rango
// combinado, el resto queda vacío. Se propaga el valor ancla a todas las
// celdas del rango antes de leer filas, para no perder esos datos.
function applyMergedCells(grid: unknown[][], merges: XLSX.Range[] | undefined): void {
  if (!merges) return;
  for (const range of merges) {
    const anchorRow = grid[range.s.r];
    if (!anchorRow) continue;
    const anchorValue = anchorRow[range.s.c];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row = grid[r];
      if (!row) continue;
      for (let c = range.s.c; c <= range.e.c; c++) {
        row[c] = anchorValue;
      }
    }
  }
}

export function readPiezasWorkbook(bytes: Uint8Array): PiezasWorkbookReadResult {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, { type: "array" });
  } catch {
    return { ok: false, missingHeaders: ALL_LABELS.slice() };
  }

  const sheetName = workbook.SheetNames[0];
  const maybeSheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!maybeSheet) return { ok: false, missingHeaders: ALL_LABELS.slice() };
  const sheet: XLSX.WorkSheet = maybeSheet;

  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
  if (grid.length === 0) return { ok: false, missingHeaders: ALL_LABELS.slice() };
  applyMergedCells(grid, sheet["!merges"]);

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

  // Si la celda del link es un hipervínculo de Excel (texto clickeable, ej.
  // "Ver imagen" con la URL "detrás" en vez de la URL como texto plano),
  // sheet_to_json solo trae el texto visible — la URL real vive en la celda
  // cruda como cell.l.Target (SheetJS sí la parsea, ver CellObject.l en
  // xlsx/types). Se prioriza esa URL sobre el texto visible de la celda.
  function linkImagenCell(rowIndex: number, row: unknown[]): string {
    const idx = columnIndex.linkImagen;
    if (idx === undefined) return "";
    const address = XLSX.utils.encode_cell({ r: rowIndex, c: idx });
    const target = sheet[address]?.l?.Target;
    if (target) return String(target).trim();
    return cell(row, "linkImagen");
  }

  const rows: RawPiezaImportRow[] = [];
  // Una fila es de juego si su SKU no está vacío y NO tiene guion — el SKU
  // madre/juego es siempre un código simple (confirmado con el usuario); una
  // pieza puede traer su propio SKU con guion (sub-SKU del juego, ej.
  // "1138-1", o uno reutilizado de otro contexto, ej. "3346-17") sin que
  // eso la confunda con el inicio de un juego nuevo. Fila de juego = mero
  // separador, no se importa como pieza (confirmado con el usuario).
  let currentJuegoSku = "";
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i] ?? [];
    const isBlank = row.every((v) => String(v ?? "").trim() === "");
    if (isBlank) continue;

    const skuCell = cell(row, "sku");
    if (skuCell && !skuCell.includes("-")) {
      currentJuegoSku = skuCell;
      continue;
    }

    rows.push({
      fila: i + 1,
      juegoSku: currentJuegoSku,
      sku: skuCell,
      origen: cell(row, "origen"),
      descripcion: cell(row, "descripcion"),
      componentesFabricacion: cell(row, "componentesFabricacion"),
      dimension: cell(row, "dimension"),
      peso: cell(row, "peso"),
      maquila: cell(row, "maquila"),
      coste: cell(row, "coste"),
      dimensionesEmpaque: cell(row, "dimensionesEmpaque"),
      linkImagen: linkImagenCell(i, row),
    });
  }

  return { ok: true, rows };
}

// --- Links de imagen (Google Drive/Photos) ---
//
// La columna trae un link público, no una imagen embebida. Google Drive
// entrega una página HTML de vista previa en el link de "compartir"
// (drive.google.com/file/d/<ID>/view) — para obtener los bytes reales de la
// imagen hay que reescribirlo a la forma de descarga directa
// (drive.google.com/uc?export=download&id=<ID>). Un link que ya apunta a
// googleusercontent.com (miniatura directa) se usa tal cual.
const URL_RE = /https?:\/\/[^\s,;]+/i;
const DRIVE_FILE_ID_RE = /\/d\/([a-zA-Z0-9_-]{10,})/;
const DRIVE_ID_PARAM_RE = /[?&]id=([a-zA-Z0-9_-]{10,})/;

// Devuelve las URLs candidatas para descargar la imagen de un link de Drive,
// en orden de confiabilidad — no una sola. drive.google.com/uc?export=download
// devuelve 403 con cierta frecuencia para peticiones no interactivas (aunque
// el archivo esté compartido públicamente); el endpoint de miniatura
// (thumbnail?id=, el mismo que usa Google Sheets para IMAGE()) es más
// confiable para imágenes y se prueba primero. Un link ya directo
// (googleusercontent.com) no tiene variantes, se prueba tal cual.
export function buildImageLinkCandidates(raw: string): string[] {
  const match = raw.match(URL_RE);
  if (!match) return [];
  let parsed: URL;
  try {
    parsed = new URL(match[0]);
  } catch {
    return [];
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "drive.google.com" || host === "docs.google.com") {
    const idMatch = match[0].match(DRIVE_FILE_ID_RE) ?? match[0].match(DRIVE_ID_PARAM_RE);
    if (idMatch) {
      const id = idMatch[1];
      return [
        `https://drive.google.com/thumbnail?id=${id}&sz=w1600`,
        `https://drive.google.com/uc?export=download&id=${id}`,
        `https://lh3.googleusercontent.com/d/${id}`,
      ];
    }
  }
  return [parsed.toString()];
}

// Para clasificación/UI: solo indica si hay un link utilizable, sin
// necesidad de la lista completa de variantes a intentar.
export function normalizeImageLink(raw: string): string | null {
  return buildImageLinkCandidates(raw)[0] ?? null;
}

// --- Clasificación de filas ---

export type PiezaRowStatus = "nueva" | "actualizar" | "sin-relacion" | "error";
export type PiezaImageStatus = "con-link" | "sin-link" | "link-invalido";

export interface ClassifiedPiezaRow extends RawPiezaImportRow {
  status: PiezaRowStatus;
  reason?: string;
  matchedJuego?: Product;
  matchedPieza?: PlasticProduct;
  imageStatus: PiezaImageStatus;
}

export interface PiezaRowLookup {
  juego: Product | null;
  pieza: PlasticProduct | null;
}

export const SIN_RELACION_MOTIVO = "No se encontró una relación con el producto";
export const SIN_JUEGO_PREVIO_MOTIVO =
  "Esta fila aparece antes de cualquier fila de juego — no se pudo determinar a qué juego pertenece";

// Topes de sanidad, no de calidad de datos — solo bloquean una celda
// corrupta/pegada por accidente con miles de caracteres.
const MAX_SHORT_FIELD_LENGTH = 500;
const MAX_LONG_FIELD_LENGTH = 10_000;

function fieldTooLong(row: RawPiezaImportRow): string | null {
  if (row.origen.length > MAX_SHORT_FIELD_LENGTH) return "Origen";
  if (row.sku.length > MAX_SHORT_FIELD_LENGTH) return "SKU";
  if (row.componentesFabricacion.length > MAX_LONG_FIELD_LENGTH) return "Componentes de Fabricación";
  if (row.dimension.length > MAX_SHORT_FIELD_LENGTH) return "Dimensiones";
  if (row.peso.length > MAX_SHORT_FIELD_LENGTH) return "Peso";
  if (row.maquila.length > MAX_SHORT_FIELD_LENGTH) return "Maquila";
  if (row.coste.length > MAX_SHORT_FIELD_LENGTH) return "Costo";
  if (row.dimensionesEmpaque.length > MAX_SHORT_FIELD_LENGTH) return "Dimensiones Empaque";
  if (row.descripcion.length > MAX_LONG_FIELD_LENGTH) return "Descripción";
  if (row.linkImagen.length > MAX_LONG_FIELD_LENGTH) return "Links Imágenes Piezas";
  return null;
}

function computeImageStatus(row: RawPiezaImportRow): PiezaImageStatus {
  const raw = row.linkImagen.trim();
  if (!raw) return "sin-link";
  return normalizeImageLink(raw) ? "con-link" : "link-invalido";
}

export function classifyPiezaRows(
  rows: RawPiezaImportRow[],
  lookups: Map<number, PiezaRowLookup>,
): ClassifiedPiezaRow[] {
  const results: ClassifiedPiezaRow[] = rows.map((row) => {
    const imageStatus = computeImageStatus(row);

    if (!row.descripcion.trim()) {
      return {
        ...row,
        status: "error",
        reason: "Falta la Descripción (se usa como nombre de la pieza).",
        imageStatus,
      };
    }

    const tooLongField = fieldTooLong(row);
    if (tooLongField) {
      return {
        ...row,
        status: "error",
        reason: `La columna "${tooLongField}" excede el largo permitido.`,
        imageStatus,
      };
    }

    // No se omite automáticamente: el usuario decide en la revisión si de
    // todas formas quiere importar la pieza al catálogo maestro sin
    // relacionarla a ningún juego.
    if (!row.juegoSku.trim()) {
      return { ...row, status: "sin-relacion", reason: SIN_JUEGO_PREVIO_MOTIVO, imageStatus };
    }

    const matchedJuego = lookups.get(row.fila)?.juego ?? null;
    if (!matchedJuego) {
      return { ...row, status: "sin-relacion", reason: SIN_RELACION_MOTIVO, imageStatus };
    }

    const matchedPieza = lookups.get(row.fila)?.pieza ?? undefined;
    if (matchedPieza) {
      return { ...row, status: "actualizar", matchedJuego, matchedPieza, imageStatus };
    }
    return { ...row, status: "nueva", matchedJuego, imageStatus };
  });

  // Pieza repetida dentro del mismo juego, dentro del mismo archivo — el
  // criterio de duplicado es SKU+juego cuando la fila trae SKU propio (más
  // preciso), o nombre+juego cuando no. Las filas "sin-relacion" no se
  // comparan entre sí: sin un juego que las desambigüe, dos piezas con el
  // mismo nombre/SKU en bloques distintos son perfectamente normales (ej.
  // "Tubo 2\"" repetido en varios juegos, o un SKU reutilizado a propósito).
  const seenPorJuego = new Map<string, number>();
  for (const row of results) {
    if (row.status !== "nueva" && row.status !== "actualizar") continue;
    if (!row.matchedJuego) continue;
    const key = row.sku.trim()
      ? `${row.matchedJuego.id}::sku::${row.sku.trim().toLowerCase()}`
      : `${row.matchedJuego.id}::nombre::${row.descripcion.trim().toLowerCase()}`;
    const firstFila = seenPorJuego.get(key);
    if (firstFila !== undefined) {
      row.status = "error";
      row.reason = `Pieza repetida dentro del mismo juego en este archivo — ya aparece en la fila ${firstFila}.`;
      row.matchedPieza = undefined;
      continue;
    }
    seenPorJuego.set(key, row.fila);
  }

  return results;
}

// Construye el PlasticProductInput a escribir para una fila ya clasificada.
// El SKU de la pieza manda cuando la fila lo trae (asignado por la
// empresa); si no lo trae, se preserva el que ya tuviera la pieza en una
// actualización — igual que Color/Material/Tipo de empaque — o queda vacío
// en un alta, listo para asignarse a mano después (ver SkuMasterSection).
export function buildPiezaInput(row: ClassifiedPiezaRow, image: ImageBlob | null): PlasticProductInput {
  return {
    nombre: row.descripcion.trim(),
    sku: row.sku.trim() || (row.matchedPieza?.sku ?? ""),
    color: row.matchedPieza?.color ?? "",
    origen: row.origen.trim(),
    descripcion: row.descripcion.trim(),
    material: row.matchedPieza?.material ?? "",
    dimension: row.dimension.trim(),
    peso: row.peso.trim(),
    tipo_empaque: row.matchedPieza?.tipo_empaque ?? "",
    maquila: row.maquila.trim(),
    coste: row.coste.trim(),
    componentes_fabricacion: row.componentesFabricacion.trim(),
    dimensiones_empaque: row.dimensionesEmpaque.trim(),
    imagen: image ?? row.matchedPieza?.imagen ?? null,
  };
}
