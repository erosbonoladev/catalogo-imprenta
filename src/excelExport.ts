import * as XLSX from "xlsx";
import type { Precio, Product, RemisionHistorialRow } from "./types";
import type { PiezaDesgloseExportRow, SkuMasterExportData } from "./db";
import { computeSkuPrincipal, parseAmount } from "./precios";

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

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// "Recetas": costeo por juego, mismo formato que la hoja "Hoja 1" del
// archivo de trabajo "Para recetas" que ya usa el negocio (confirmado con
// el usuario) — una fila resumen por juego (suma de sus piezas) seguida de
// sus piezas, cada una con su propio peso/costo "por pieza" y "por juego"
// (= por pieza × cantidad necesaria, product_plastic_items.orden no
// cambia). A diferencia de "Desglose" (plana, pensada para reimportarse vía
// la importación masiva de Piezas — ver piezasImport.ts/readDesgloseSheet),
// esta hoja es de solo consulta/costeo, no se reimporta: si algún día hace
// falta reimportar recetas, que sea un lector nuevo, no reusar este.
//
// "Peso/Costo por pieza" salen de plastic_products.peso/coste (texto libre,
// parseAmount() los valida — si no son un número limpio, esa celda y las
// que dependen de ella quedan vacías, no se inventa un valor). "Peso/Costo
// por juego" de una pieza = por pieza × Componentes de fabricación; los del
// juego = suma de TODAS sus piezas ligadas, sin distinguir piezas de
// empaque (bolsas, instructivos) de piezas reales del juguete (best-effort:
// una pieza sin peso/costo parseable no aporta a la suma, en vez de
// invalidar todo el juego) — confirmado con el usuario, quien decidió sumar
// todo tal cual por simplicidad. Comparado contra un bloque real de "Hoja
// 1" (juego "Juego del Granjero"/2035): el Costo por juego resultante
// cuadra exacto porque esa hoja también suma el empaque al costo, pero el
// Peso por juego puede quedar un poco por encima del peso real del juguete
// armado, porque esa hoja SÍ excluye el empaque del peso y aquí no hay
// forma de distinguir una pieza de empaque de una pieza real — no tratar
// esta columna como dato exacto para logística, es una aproximación de
// referencia para costeo.
// "Precio por pieza"/"Precio por juego" buscan el SKU exacto de esa fila en
// `precios` (mismo criterio que "Precios Imprenta": cada SKU se cotiza
// aparte, no se suman juegos y piezas — ver DATABASE.md). "Factor precio" =
// Precio ÷ Costo del juego, una razón calculada para referencia, no un dato
// guardado. "Juegos por empaque"/"Peso empaque"/"Volumen empaque"/"Costo
// por Kg" no existen en ninguna tabla — quedan vacías con su encabezado,
// mismo criterio que "Cantidad" en Desglose.
export function recetasSheetRows(piezas: PiezaDesgloseExportRow[], precios: Precio[]): unknown[][] {
  const aoa: unknown[][] = [
    [
      "SKU Principal",
      "SKU",
      "Descripción",
      "Componentes de fabricación",
      "Dimensiones",
      "Peso por pieza (Kg)",
      "Costo por pieza",
      "Peso por juego (Kg)",
      "Costo por juego",
      "Juegos por empaque",
      "Peso empaque (Kg)",
      "Volumen empaque (M3)",
      "Precio por pieza",
      "Precio por juego",
      "Costo por Kg",
      "Factor precio",
      "Origen",
      "Maquila",
      "Dimensiones de empaque",
      "Link imágenes piezas",
    ],
  ];

  const precioBySku = new Map(precios.map((p) => [p.sku, p]));

  // `piezas` ya viene ordenada por producto_codigo (fetchPiezasDesgloseParaExport,
  // nulls al final) — agrupar preservando ese orden alcanza, sin reordenar.
  // Las piezas sin juego (producto_codigo null) no tienen receta que
  // mostrar, se excluyen (siguen apareciendo en "Desglose").
  const porJuego = new Map<string, PiezaDesgloseExportRow[]>();
  for (const p of piezas) {
    if (!p.producto_codigo) continue;
    const grupo = porJuego.get(p.producto_codigo);
    if (grupo) grupo.push(p);
    else porJuego.set(p.producto_codigo, [p]);
  }

  for (const [codigo, grupo] of porJuego) {
    const skuPrincipal = computeSkuPrincipal(codigo);
    let componentesTotal = 0;
    let pesoJuegoTotal = 0;
    let costoJuegoTotal = 0;
    const filasPiezas: unknown[][] = [];

    for (const p of grupo) {
      const componentes = parseAmount(p.componentes_fabricacion);
      const pesoPieza = parseAmount(p.peso);
      const costoPieza = parseAmount(p.coste);
      const pesoJuego = pesoPieza !== null && componentes !== null ? pesoPieza * componentes : null;
      const costoJuego = costoPieza !== null && componentes !== null ? costoPieza * componentes : null;
      if (componentes !== null) componentesTotal += componentes;
      if (pesoJuego !== null) pesoJuegoTotal += pesoJuego;
      if (costoJuego !== null) costoJuegoTotal += costoJuego;

      const precioPieza = p.sku ? precioBySku.get(p.sku) : undefined;

      filasPiezas.push([
        skuPrincipal,
        p.sku,
        p.nombre,
        p.componentes_fabricacion,
        p.dimension,
        pesoPieza ?? "",
        costoPieza !== null ? formatMoney(costoPieza) : "",
        pesoJuego !== null ? round3(pesoJuego) : "",
        costoJuego !== null ? formatMoney(costoJuego) : "",
        "",
        "",
        "",
        precioPieza ? formatMoney(precioPieza.precio) : "",
        "",
        "",
        "",
        p.origen,
        p.maquila,
        p.dimensiones_empaque,
        "",
      ]);
    }

    const precioJuego = precioBySku.get(codigo);
    const factor = precioJuego && costoJuegoTotal > 0 ? precioJuego.precio / costoJuegoTotal : null;

    aoa.push([
      skuPrincipal,
      codigo,
      grupo[0].producto_nombre ?? "",
      componentesTotal || "",
      "",
      "",
      "",
      pesoJuegoTotal ? round3(pesoJuegoTotal) : "",
      costoJuegoTotal ? formatMoney(costoJuegoTotal) : "",
      "",
      "",
      "",
      "",
      precioJuego ? formatMoney(precioJuego.precio) : "",
      "",
      factor !== null ? factor.toFixed(2) : "",
      "",
      "",
      "",
      "",
    ]);
    aoa.push(...filasPiezas);
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
    { name: "Recetas", aoa: recetasSheetRows(data.piezas, data.precios) },
    { name: "Precios Imprenta", aoa: preciosExportSheetRows(data.precios) },
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
