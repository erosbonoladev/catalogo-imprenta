// Geometría de Assets/remision-template.png (en pt, página de 595.5×842.25),
// compartida por buildRemisionPdf (pdf.ts) y la hoja interactiva
// (RemisionSheet.tsx) para que lo que se edita en pantalla y lo que sale en el
// PDF caigan en el mismo lugar. Medida sobre el raster original (1696×2400,
// escala 595.5/1696) detectando líneas de la cuadrícula y cajas de texto, no a
// ojo: la tabla tiene 16 renglones, no 15.
import type { TipoRemision } from "./types";

export const PAGE_W = 595.5;
export const PAGE_H = 842.25;

export const ROWS_PER_PAGE = 16;
export const ROW_TOP0 = 257.2;
export const ROW_PITCH = 27.04;

export function rowCenterY(row: number): number {
  return ROW_TOP0 + ROW_PITCH * (row + 0.5);
}

// Columnas: [x inicial, x final] de cada celda (entre líneas verticales).
// La plantilla externa (Assets/remision-template-externa.png, ver
// scripts/generate-remision-template-externa.py) no tiene columna Clave:
// Cantidad pasa a ser la primera y Producto se ensancha hacia la izquierda.
export interface TableColumns {
  clave: [number, number] | null;
  cantidad: [number, number];
  producto: [number, number];
  precio: [number, number];
  importe: [number, number];
  // El texto del producto arranca alineado con el encabezado "Producto".
  productoTextX: number;
  precioTextRight: number;
  importeTextRight: number;
}

const COLS_INTERNA: TableColumns = {
  clave: [24, 63.5],
  cantidad: [64.8, 122.5],
  producto: [123.9, 412],
  precio: [413.5, 474.4],
  importe: [475.6, 579],
  productoTextX: 136.6,
  precioTextRight: 470,
  importeTextRight: 574,
};

const COLS_EXTERNA: TableColumns = {
  ...COLS_INTERNA,
  clave: null,
  cantidad: [24, 81],
  producto: [83.2, 412],
  productoTextX: 95.9,
};

export function columnsFor(tipo: TipoRemision): TableColumns {
  return tipo === "externa" ? COLS_EXTERNA : COLS_INTERNA;
}

// Campos de encabezado: centro (x, y) del valor y rectángulo blanco [x, y, w, h]
// que tapa el valor de ejemplo (XXXXXX / DD/MM/AA / JALISCO) horneado en la plantilla.
export const FOLIO = { cx: 523, cy: 170.1, erase: [462, 164, 121, 12] as Rect, maxWidth: 112 };
export const FECHA = { cx: 366, cy: 214.5, erase: [310, 208, 112, 13] as Rect };
export const PEDIDO = { cx: 521, cy: 214.5, erase: [462, 208, 119, 13] as Rect, maxWidth: 114 };

// Bloque de datos del cliente (solo plantilla externa, a la izquierda bajo la
// línea gruesa). Etiquetas en negritas y valores alineados en una columna.
export type ClienteCampo = "cliente" | "rfc" | "direccion" | "contacto" | "telefono";
export const CLIENTE_BLOCK = {
  labelX: 25.3,
  valueX: 78,
  valueMaxWidth: 215,
  firstCy: 148,
  pitch: 13,
  fields: [
    { campo: "cliente", label: "Cliente:" },
    { campo: "rfc", label: "RFC:" },
    { campo: "direccion", label: "Dirección:" },
    { campo: "contacto", label: "Contacto:" },
    { campo: "telefono", label: "Tel:" },
  ] as { campo: ClienteCampo; label: string }[],
};

export const PRECIO_TEXTO = { x: 23, y: 715.5, w: 400, h: 52, lineHeight: 11 };

// Totales: los rótulos horneados terminan en x≈505.3; los valores van a su derecha.
export const TOTALES_RIGHT = 575.5;
export const TOTAL_CY = {
  subtotal: 708,
  descuentoPct: 720.2,
  descuento: 732.3,
  iva: 744,
  total: 766.2,
};

export type Rect = [number, number, number, number];

export const FONT_BODY = 9.5;
export const FONT_HEADER_FIELD = 10.5;
export const FONT_TOTALES = 10;

export function formatFechaHoja(fechaIso: string): string {
  const [y, m, d] = fechaIso.split("-");
  if (!y || !m || !d) return fechaIso;
  return `${d}/${m}/${y.slice(2)}`;
}

// El folio completo (REM-JALISCO-161026-00001 / REMEX-…) identifica el
// archivo y la BD; en el documento solo se imprime el consecutivo.
export function folioImpreso(folio: string): string {
  return folio.split("-").pop() || folio;
}
