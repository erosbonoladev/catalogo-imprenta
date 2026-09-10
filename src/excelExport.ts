import * as XLSX from "xlsx";
import type { Precio, Product, RemisionHistorialRow } from "./types";
import type { PiezaDesgloseExportRow, SkuMasterExportData } from "./db";
import { computeSkuPrincipal } from "./precios";

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

function productosSheetRows(productos: Product[]): unknown[][] {
  const aoa: unknown[][] = [
    [
      "SKU Principal",
      "Clave",
      "Nombre",
      "Categoría",
      "Material",
      "Descripción",
      "Presentación original",
      "Creado",
      "Actualizado",
    ],
  ];
  for (const p of productos) {
    aoa.push([
      computeSkuPrincipal(p.codigo),
      p.codigo,
      p.nombre,
      p.categoria,
      p.material,
      p.descripcion,
      p.presentacion_original,
      formatFechaDDMMYYYY(p.creado_en),
      formatFechaDDMMYYYY(p.actualizado_en),
    ]);
  }
  return aoa;
}

// "Cantidad" queda siempre vacía: product_plastic_items (join ficha↔pieza)
// no tiene columna de cantidad en el esquema actual — se deja la cabecera
// para que sea claro qué información falta, sin inventar un valor.
function desgloseSheetRows(piezas: PiezaDesgloseExportRow[]): unknown[][] {
  const aoa: unknown[][] = [
    [
      "SKU Principal",
      "Producto (Clave)",
      "Producto (Nombre)",
      "Orden",
      "SKU Pieza",
      "Nombre Pieza",
      "Cantidad",
      "Descripción",
      "Material",
      "Color",
      "Origen",
      "Dimensión",
      "Peso",
      "Tipo de empaque",
      "Maquila",
      "Costo",
      "Componentes de fabricación",
      "Dimensiones de empaque",
    ],
  ];
  for (const p of piezas) {
    const skuPrincipal = p.producto_codigo
      ? computeSkuPrincipal(p.producto_codigo)
      : p.sku
        ? computeSkuPrincipal(p.sku)
        : "";
    aoa.push([
      skuPrincipal,
      p.producto_codigo ?? "",
      p.producto_nombre ?? "",
      p.orden ?? "",
      p.sku,
      p.nombre,
      "",
      p.descripcion,
      p.material,
      p.color,
      p.origen,
      p.dimension,
      p.peso,
      p.tipo_empaque,
      p.maquila,
      p.coste,
      p.componentes_fabricacion,
      p.dimensiones_empaque,
    ]);
  }
  return aoa;
}

function preciosExportSheetRows(precios: Precio[]): unknown[][] {
  const aoa: unknown[][] = [
    ["SKU Principal", "Clave", "Nombre", "Precio", "Tipo", "Actualizado", "Actualizado por"],
  ];
  for (const p of precios) {
    aoa.push([
      p.sku_principal,
      p.sku,
      p.nombre,
      formatMoney(p.precio),
      p.tipo === "externo" ? "Externo" : "Interno",
      formatFechaDDMMYYYY(p.actualizado_en),
      p.actualizado_por ?? "",
    ]);
  }
  return aoa;
}

function remisionesExportSheetRows(rows: RemisionHistorialRow[]): unknown[][] {
  const aoa: unknown[][] = [
    [
      "SKU Principal",
      "Fecha",
      "Folio",
      "Bodega",
      "Cancelada",
      "Renglón",
      "Clave",
      "Producto",
      "Cantidad",
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
      r.sku ? computeSkuPrincipal(r.sku) : "",
      formatFechaDDMMYYYY(r.fecha),
      r.folio,
      r.pedido_bodegas || "Sin bodega",
      r.cancelada ? "Sí" : "No",
      r.numero_renglon,
      r.sku,
      r.producto_nombre,
      r.cantidad,
      formatMoney(r.precio_unitario),
      formatMoney(r.importe),
      formatMoney(r.subtotal),
      `${r.descuento_pct}%`,
      formatMoney(r.descuento),
      formatMoney(r.iva),
      formatMoney(r.total),
    ]);
  }
  return aoa;
}

// Un producto/pieza/precio/remisión puede repetirse en varias filas (varias
// piezas por producto, varios precios o remisiones por SKU) — por eso 4
// hojas separadas en vez de una sola tabla aplanada, relacionables entre sí
// por la columna "SKU Principal" (mismo criterio de agrupación que
// SkuMasterSection, ver computeSkuPrincipal en src/precios.ts) que se agrega
// en cada hoja aunque no exista como columna real en ninguna tabla de la BD.
export function buildSkuMasterWorkbook(data: SkuMasterExportData): Uint8Array {
  return buildMultiSheetWorkbookBytes([
    { name: "Productos", aoa: productosSheetRows(data.productos) },
    { name: "Desglose", aoa: desgloseSheetRows(data.piezas) },
    { name: "Precios", aoa: preciosExportSheetRows(data.precios) },
    { name: "Remisiones", aoa: remisionesExportSheetRows(data.remisiones) },
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
