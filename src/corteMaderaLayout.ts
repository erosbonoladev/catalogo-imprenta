import { parseAmount } from "./precios";

// Cortes de Madera: calculadora de aprovechamiento de placas de MDF.
// Todo el cálculo interno vive en milímetros (recomendación del usuario) para
// poder sumar el margen obligatorio de 3mm sin errores de precisión — la UI
// convierte a/desde centímetros solo para mostrar.

export const SHEET_WIDTH_MM = 1220; // 122 cm, fijo, no editable desde la UI
export const SHEET_HEIGHT_MM = 2440; // 244 cm, fijo, no editable desde la UI
// Margen físico que deja la cortadora entre cada corte — el usuario decide
// si incluirlo o no (parámetro `incluirMargenCortadora` de
// computeSheetLayout, checkbox en CortesMaderaSection, activado por
// defecto porque refleja la realidad física de la máquina).
export const CUTTER_GAP_MM = 3;
export const GRAMAJES_MADERA = [2.5, 5.5] as const;
export type GramajeMadera = (typeof GRAMAJES_MADERA)[number];

export const NO_CABE_MESSAGE = "La pieza seleccionada no cabe en una placa de MDF de 122 × 244 cm.";

export interface PieceSizeMm {
  widthMm: number;
  heightMm: number;
}

export interface PlacedPieceMm {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  rotated: boolean;
}

export type SheetLayoutResult =
  | {
      ok: true;
      piece: PieceSizeMm;
      gapMm: number;
      placed: PlacedPieceMm[];
      count: number;
      sheetAreaMm2: number;
      usedAreaMm2: number;
      wasteAreaMm2: number;
      usedAreaPct: number;
      wastePct: number;
      orientation: "normal" | "rotada" | "combinada";
    }
  | { ok: false; reason: string };

// Parser estricto para dimensiones tecleadas a mano/leídas del catálogo
// (cm) — reutiliza parseAmount (src/precios.ts, ya usado por
// Remisiones/Precios/Maderas) en vez de duplicar el parseo de números con
// coma o punto decimal. Vacío/inválido/<=0 -> null.
export function parseDimensionCm(raw: string): number | null {
  const value = parseAmount(raw);
  if (value === null || value <= 0) return null;
  return value * 10;
}

// Modo "Pieza": el campo "Pieza" (ex-Tamaño) de wood_products es texto
// libre sin garantía de traer una medida — se intenta reconocer un patrón
// "NN x NN" (cm, admite "x"/"×" y espacios variables). Si no se reconoce,
// el modo Pieza queda deshabilitado para esa pieza puntual (decisión
// confirmada con el usuario) y la UI ofrece Armado o captura manual.
const MEDIDA_RE = /(\d+(?:[.,]\d+)?)\s*[x×X]\s*(\d+(?:[.,]\d+)?)/;

export function parsePiezaMedidaFromTexto(texto: string): PieceSizeMm | null {
  const match = texto.match(MEDIDA_RE);
  if (!match) return null;
  const widthCm = parseAmount(match[1]);
  const heightCm = parseAmount(match[2]);
  if (widthCm === null || heightCm === null || widthCm <= 0 || heightCm <= 0) return null;
  return { widthMm: widthCm * 10, heightMm: heightCm * 10 };
}

interface GridStats {
  cols: number;
  rows: number;
  count: number;
  usedWidthMm: number;
  usedHeightMm: number;
}

const EMPTY_STATS: GridStats = { cols: 0, rows: 0, count: 0, usedWidthMm: 0, usedHeightMm: 0 };

// n = floor((L + gap) / (p + gap)) es la cantidad máxima de piezas de
// tamaño p que caben en un segmento de largo L dejando gapMm entre piezas
// consecutivas — sin gap sobrante al final NI margen reservado al inicio:
// la primera pieza siempre queda pegada al borde de la región (x=0/y=0),
// el margen de 3mm+usuario es exclusivamente el espacio ENTRE piezas, nunca
// se descuenta espacio extra en los bordes de la placa.
function gridStats(
  regionWidthMm: number,
  regionHeightMm: number,
  pieceWidthMm: number,
  pieceHeightMm: number,
  gapMm: number,
): GridStats {
  if (regionWidthMm <= 0 || regionHeightMm <= 0) return EMPTY_STATS;
  const cols = Math.floor((regionWidthMm + gapMm) / (pieceWidthMm + gapMm));
  const rows = Math.floor((regionHeightMm + gapMm) / (pieceHeightMm + gapMm));
  if (cols <= 0 || rows <= 0) return EMPTY_STATS;
  return {
    cols,
    rows,
    count: cols * rows,
    usedWidthMm: cols * pieceWidthMm + (cols - 1) * gapMm,
    usedHeightMm: rows * pieceHeightMm + (rows - 1) * gapMm,
  };
}

// Plan de acomodo: una cuadrícula uniforme (hoja) o la combinación de un
// bloque base + el mejor plan encontrado para la región sobrante (rama) —
// la recursión permite encadenar varias franjas alternando orientación
// ("filas en vertical y en horizontal"), no solo una.
type PackPlan =
  | {
      kind: "grid";
      regionX: number;
      regionY: number;
      pieceWidthMm: number;
      pieceHeightMm: number;
      rotated: boolean;
      cols: number;
      rows: number;
    }
  | { kind: "combo"; base: PackPlan; rest: PackPlan };

interface SearchResult {
  plan: PackPlan | null;
  count: number;
}

const EMPTY_SEARCH: SearchResult = { plan: null, count: 0 };

// Profundidad máxima de combinaciones encadenadas — con cada nivel usando
// además la búsqueda de "mejor k" de abajo (no solo el bloque máximo), el
// resultado converge rápido; una profundidad moderada alcanza de sobra
// para que el remanente deje de tener espacio útil.
const MAX_SPLIT_DEPTH = 4;

function gridPlanFrom(originX: number, originY: number, pw: number, ph: number, rotated: boolean, stats: GridStats): PackPlan {
  return {
    kind: "grid",
    regionX: originX,
    regionY: originY,
    pieceWidthMm: pw,
    pieceHeightMm: ph,
    rotated,
    cols: stats.cols,
    rows: stats.rows,
  };
}

// Búsqueda recursiva por regiones (fase 1, solo cuenta — no arma las
// piezas todavía, para no pagar el costo de construir arreglos grandes en
// ramas que después se descartan).
//
// Clave del algoritmo: para cada orientación no solo se prueba el bloque
// de columnas/filas MÁXIMO antes de recursar sobre el remanente — eso
// puede ser subóptimo (ej. 3 columnas de una pieza rotada dejan una franja
// demasiado angosta para aprovechar, pero 2 columnas dejan una franja
// justo lo bastante ancha para una columna completa de la otra
// orientación, dando más piezas en total). Se prueban TODOS los valores de
// k (columnas/filas del bloque base) y se elige el que maximiza
// k*filasDelBloque + mejor-grilla-simple-del-remanente — ese k gana la
// recursión completa (que sí permite combinaciones más profundas). Costo:
// O(maxCols+maxRows) evaluaciones aritméticas por nivel, nada de
// recursión extra en ese barrido. Empates se resuelven siempre en el mismo
// orden (normal antes que rotada; columnas antes que filas; menor k antes
// que mayor k) para que el resultado nunca cambie entre corridas.
function searchRegion(
  originX: number,
  originY: number,
  regionWidthMm: number,
  regionHeightMm: number,
  pieceWidthMm: number,
  pieceHeightMm: number,
  gapMm: number,
  depth: number,
): SearchResult {
  if (regionWidthMm <= 0 || regionHeightMm <= 0) return EMPTY_SEARCH;

  function simpleBestCount(w: number, h: number): number {
    if (w <= 0 || h <= 0) return 0;
    const a = gridStats(w, h, pieceWidthMm, pieceHeightMm, gapMm).count;
    const b = gridStats(w, h, pieceHeightMm, pieceWidthMm, gapMm).count;
    return Math.max(a, b);
  }

  function gridSearch(rotated: boolean): SearchResult {
    const pw = rotated ? pieceHeightMm : pieceWidthMm;
    const ph = rotated ? pieceWidthMm : pieceHeightMm;
    const stats = gridStats(regionWidthMm, regionHeightMm, pw, ph, gapMm);
    if (stats.count === 0) return EMPTY_SEARCH;
    return { plan: gridPlanFrom(originX, originY, pw, ph, rotated, stats), count: stats.count };
  }

  let best = gridSearch(false);
  const rotatedFull = gridSearch(true);
  if (rotatedFull.count > best.count) best = rotatedFull;

  if (depth < MAX_SPLIT_DEPTH) {
    for (const rotated of [false, true]) {
      const pw = rotated ? pieceHeightMm : pieceWidthMm;
      const ph = rotated ? pieceWidthMm : pieceHeightMm;

      // Eje columnas: k columnas de (pw x ph) usando todas las filas que
      // entren, remanente a la derecha.
      const rowsForCols = Math.floor((regionHeightMm + gapMm) / (ph + gapMm));
      const maxCols = Math.floor((regionWidthMm + gapMm) / (pw + gapMm));
      if (rowsForCols > 0 && maxCols > 0) {
        let bestK = 1;
        let bestKTotal = -1;
        for (let k = 1; k <= maxCols; k++) {
          const usedWidthK = k * pw + (k - 1) * gapMm;
          const leftoverWidth = regionWidthMm - usedWidthK - gapMm;
          const total = k * rowsForCols + simpleBestCount(leftoverWidth, regionHeightMm);
          if (total > bestKTotal) {
            bestKTotal = total;
            bestK = k;
          }
        }
        const baseStats: GridStats = {
          cols: bestK,
          rows: rowsForCols,
          count: bestK * rowsForCols,
          usedWidthMm: bestK * pw + (bestK - 1) * gapMm,
          usedHeightMm: rowsForCols * ph + (rowsForCols - 1) * gapMm,
        };
        const basePlan = gridPlanFrom(originX, originY, pw, ph, rotated, baseStats);
        const rightX = originX + baseStats.usedWidthMm + gapMm;
        const rightW = originX + regionWidthMm - rightX;
        const rightRest = searchRegion(rightX, originY, rightW, regionHeightMm, pieceWidthMm, pieceHeightMm, gapMm, depth + 1);
        const combined = baseStats.count + rightRest.count;
        if (combined > best.count) {
          best = rightRest.plan
            ? { plan: { kind: "combo", base: basePlan, rest: rightRest.plan }, count: combined }
            : { plan: basePlan, count: baseStats.count };
        }
      }

      // Eje filas: k filas de (pw x ph) usando todas las columnas que
      // entren, remanente abajo.
      const colsForRows = Math.floor((regionWidthMm + gapMm) / (pw + gapMm));
      const maxRows = Math.floor((regionHeightMm + gapMm) / (ph + gapMm));
      if (colsForRows > 0 && maxRows > 0) {
        let bestK = 1;
        let bestKTotal = -1;
        for (let k = 1; k <= maxRows; k++) {
          const usedHeightK = k * ph + (k - 1) * gapMm;
          const leftoverHeight = regionHeightMm - usedHeightK - gapMm;
          const total = k * colsForRows + simpleBestCount(regionWidthMm, leftoverHeight);
          if (total > bestKTotal) {
            bestKTotal = total;
            bestK = k;
          }
        }
        const baseStats: GridStats = {
          cols: colsForRows,
          rows: bestK,
          count: bestK * colsForRows,
          usedWidthMm: colsForRows * pw + (colsForRows - 1) * gapMm,
          usedHeightMm: bestK * ph + (bestK - 1) * gapMm,
        };
        const basePlan = gridPlanFrom(originX, originY, pw, ph, rotated, baseStats);
        const belowY = originY + baseStats.usedHeightMm + gapMm;
        const belowH = originY + regionHeightMm - belowY;
        const belowRest = searchRegion(originX, belowY, regionWidthMm, belowH, pieceWidthMm, pieceHeightMm, gapMm, depth + 1);
        const combined = baseStats.count + belowRest.count;
        if (combined > best.count) {
          best = belowRest.plan
            ? { plan: { kind: "combo", base: basePlan, rest: belowRest.plan }, count: combined }
            : { plan: basePlan, count: baseStats.count };
        }
      }
    }
  }

  return best;
}

// Fase 2: solo se llama una vez, sobre el plan ganador — arma las piezas
// reales (coordenadas) recorriendo el árbol de combinaciones.
function materializePlan(plan: PackPlan, gapMm: number): PlacedPieceMm[] {
  if (plan.kind === "combo") {
    return [...materializePlan(plan.base, gapMm), ...materializePlan(plan.rest, gapMm)];
  }
  const placed: PlacedPieceMm[] = [];
  for (let r = 0; r < plan.rows; r++) {
    for (let c = 0; c < plan.cols; c++) {
      placed.push({
        xMm: plan.regionX + c * (plan.pieceWidthMm + gapMm),
        yMm: plan.regionY + r * (plan.pieceHeightMm + gapMm),
        widthMm: plan.pieceWidthMm,
        heightMm: plan.pieceHeightMm,
        rotated: plan.rotated,
      });
    }
  }
  return placed;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// Algoritmo determinista de aprovechamiento para piezas idénticas: busca,
// por regiones, la mejor combinación de cuadrículas uniformes en ambas
// orientaciones (normal/rotada 90°), permitiendo encadenar varias franjas
// alternadas ("filas en vertical y en horizontal") en vez de asumir que
// "filas × columnas" de una sola orientación siempre es lo óptimo.
// Crucial: para cada bloque no solo se prueba el número MÁXIMO de
// columnas/filas — se prueban todos los valores posibles, porque usar
// menos a veces deja una franja sobrante justo lo bastante ancha/alta para
// una columna/fila completa de la otra orientación (ej. verificado con un
// caso real: 3 columnas rotadas de una pieza dan 15 piezas, pero 2
// columnas + la franja sobrante con la otra orientación dan 17 — ver test
// "caso reportado por el usuario" en tests/corteMaderaLayout.test.ts). El
// margen (margen de la cortadora, si se incluye, + margen del usuario) es
// exclusivamente el espacio entre piezas — nunca se reserva espacio extra
// en los bordes de la placa, la primera pieza de cada fila/columna siempre
// queda pegada al borde real (0,0).
export function computeSheetLayout(
  piece: PieceSizeMm,
  marginMm: number,
  incluirMargenCortadora: boolean = true,
): SheetLayoutResult {
  if (!(piece.widthMm > 0) || !(piece.heightMm > 0)) {
    return { ok: false, reason: "Las dimensiones de la pieza deben ser mayores a 0." };
  }
  if (!(marginMm >= 0)) {
    return { ok: false, reason: "El margen no puede ser negativo." };
  }

  const gapMm = (incluirMargenCortadora ? CUTTER_GAP_MM : 0) + marginMm;

  const normalFits = piece.widthMm <= SHEET_WIDTH_MM && piece.heightMm <= SHEET_HEIGHT_MM;
  const rotatedFits = piece.heightMm <= SHEET_WIDTH_MM && piece.widthMm <= SHEET_HEIGHT_MM;
  if (!normalFits && !rotatedFits) {
    return { ok: false, reason: NO_CABE_MESSAGE };
  }

  const search = searchRegion(0, 0, SHEET_WIDTH_MM, SHEET_HEIGHT_MM, piece.widthMm, piece.heightMm, gapMm, 0);
  if (!search.plan || search.count === 0) {
    return { ok: false, reason: NO_CABE_MESSAGE };
  }

  const finalPlaced = materializePlan(search.plan, gapMm);
  const hasNormal = finalPlaced.some((p) => !p.rotated);
  const hasRotated = finalPlaced.some((p) => p.rotated);
  const orientation: "normal" | "rotada" | "combinada" =
    hasNormal && hasRotated ? "combinada" : hasRotated ? "rotada" : "normal";

  const sheetAreaMm2 = SHEET_WIDTH_MM * SHEET_HEIGHT_MM;
  const usedAreaMm2 = finalPlaced.reduce((sum, p) => sum + p.widthMm * p.heightMm, 0);
  const wasteAreaMm2 = sheetAreaMm2 - usedAreaMm2;

  return {
    ok: true,
    piece,
    gapMm,
    placed: finalPlaced,
    count: finalPlaced.length,
    sheetAreaMm2,
    usedAreaMm2,
    wasteAreaMm2,
    usedAreaPct: round1((usedAreaMm2 / sheetAreaMm2) * 100),
    wastePct: round1((wasteAreaMm2 / sheetAreaMm2) * 100),
    orientation,
  };
}
