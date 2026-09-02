import * as XLSX from "xlsx";
import type { Precio, RemisionHistorialRow } from "./types";

const moneyFormatter = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatMoney(n: number): string {
  return moneyFormatter.format(n);
}

function formatFechaDDMMYYYY(fechaSql: string): string {
  const [fecha] = fechaSql.split(" ");
  const [y, m, d] = fecha.split("-");
  if (!y || !m || !d) return fechaSql;
  return `${d}/${m}/${y}`;
}

function buildWorkbookBytes(sheetName: string, aoa: unknown[][]): Uint8Array {
  return buildMultiSheetWorkbookBytes([{ name: sheetName, aoa }]);
}

function buildMultiSheetWorkbookBytes(sheets: { name: string; aoa: unknown[][] }[]): Uint8Array {
  const workbook = XLSX.utils.book_new();
  for (const { name, aoa } of sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(aoa), name);
  }
  const out = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  return new Uint8Array(out as ArrayBuffer);
}

function preciosSheetRows(precios: Precio[]): unknown[][] {
  const aoa: unknown[][] = [["Clave", "Producto", "Precio", "Modificado", "Tipo"]];
  for (const p of precios) {
    aoa.push([
      p.sku,
      p.nombre,
      formatMoney(p.precio),
      formatFechaDDMMYYYY(p.actualizado_en),
      p.tipo === "externo" ? "Externo" : "Interno",
    ]);
  }
  return aoa;
}

// Un producto nunca aparece en ambas hojas: "externo" (tipo === "externo")
// va solo a "Externos"; todo lo demás (incluido tipo NULL — productos
// guardados antes de esta clasificación) se trata como interno y se queda
// en "Lista de precios", igual que antes de agregar esta clasificación.
export function buildPreciosListWorkbook(precios: Precio[]): Uint8Array {
  const internos = precios.filter((p) => p.tipo !== "externo");
  const externos = precios.filter((p) => p.tipo === "externo");
  return buildMultiSheetWorkbookBytes([
    { name: "Lista de precios", aoa: preciosSheetRows(internos) },
    { name: "Externos", aoa: preciosSheetRows(externos) },
  ]);
}

export function buildRemisionesHistorialWorkbook(rows: RemisionHistorialRow[]): Uint8Array {
  const aoa: unknown[][] = [
    [
      "Fecha",
      "Folio",
      "Pedido Bodegas",
      "Cancelado",
      "Renglón",
      "Clave",
      "Cuantos",
      "Producto",
      "Precio",
      "Importe",
      "Subtotal",
      "Descuento %",
      "Descuento",
      "IVA",
      "Total",
    ],
  ];
  for (const r of rows) {
    aoa.push([
      formatFechaDDMMYYYY(r.fecha),
      r.folio,
      r.pedido_bodegas,
      r.cancelada ? "Sí" : "No",
      r.numero_renglon,
      r.sku,
      r.cantidad,
      r.producto_nombre,
      formatMoney(r.precio_unitario),
      formatMoney(r.importe),
      formatMoney(r.subtotal),
      `${r.descuento_pct}%`,
      formatMoney(r.descuento),
      formatMoney(r.iva),
      formatMoney(r.total),
    ]);
  }
  return buildWorkbookBytes("Historial de remisiones", aoa);
}
