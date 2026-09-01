import { jsPDF } from "jspdf";
import type { PrintItem, PrintItemOrder, Product, Remision, RemisionRenglon } from "./types";
import clioLogoUrl from "../Assets/clio.png";
import remisionTemplateUrl from "../Assets/remision-template.png";
import { formatMoney } from "./excelExport";

interface Logo {
  img: HTMLImageElement;
  w: number;
  h: number;
}

let logoPromise: Promise<Logo | null> | null = null;

function getLogo(): Promise<Logo | null> {
  if (!logoPromise) {
    logoPromise = (async () => {
      try {
        const img = new Image();
        img.src = clioLogoUrl;
        await img.decode();
        return { img, w: img.naturalWidth, h: img.naturalHeight };
      } catch (err) {
        console.warn("No se pudo cargar la imagen corporativa para el PDF:", err);
        return null;
      }
    })();
  }
  return logoPromise;
}

const LOGO_MAX_WIDTH = 100;
const LOGO_MAX_HEIGHT = 70;

async function drawLogo(doc: jsPDF, marginX: number, pageWidth: number): Promise<void> {
  const logo = await getLogo();
  if (!logo) return;
  const scale = Math.min(LOGO_MAX_WIDTH / logo.w, LOGO_MAX_HEIGHT / logo.h, 1);
  const drawW = logo.w * scale;
  const drawH = logo.h * scale;
  doc.addImage(logo.img, "PNG", pageWidth - marginX - drawW, 28, drawW, drawH);
}

export interface OrderEntry {
  item: PrintItem;
  merma: number;
  cantidadArte: number;
  numeroTiros: number;
  totalPliegos: number;
  totalPorPliego: number;
}

export interface PurchaseEntry {
  item: PrintItem;
  baseOrder: PrintItemOrder;
  papel: string;
  pliego: string;
  maquina: string;
  cortes: number;
  cantidad: number;
  totalTamanos: number;
}

const PLACAS_EXISTENTES_LABEL: Record<string, string> = {
  "": "Sin definir",
  si: "Sí",
  no: "No",
};

const PROCESOS_ORDEN_PDF = ["Plástico", "Barniz UV", "Barniz de máquina", "Suaje", "Guillotina"] as const;

const CAMPOS: { label: string; get: (item: PrintItem) => string }[] = [
  { label: "Tipo de papel", get: (i) => i.tipo_papel },
  { label: "Gramos o puntos", get: (i) => i.gramos_puntos },
  { label: "Máquina", get: (i) => i.maquina },
  { label: "Formación", get: (i) => i.formacion },
  { label: "Tamaño extendido", get: (i) => i.tamano_extendido },
  { label: "Tamaño Final", get: (i) => i.tamano_final },
  { label: "Número de pliegos", get: (i) => i.numero_pliegos },
  { label: "Tintas", get: (i) => i.tintas },
  { label: "Número de placas", get: (i) => i.numero_placas },
  { label: "Placas existentes", get: (i) => PLACAS_EXISTENTES_LABEL[i.placas_existentes] ?? "Sin definir" },
];

export async function buildOrderPdf(
  product: Product,
  entries: OrderEntry[],
  folio: string,
): Promise<Uint8Array> {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const marginX = 48;
  const pageHeight = doc.internal.pageSize.getHeight();
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 56;
  await drawLogo(doc, marginX, pageWidth);

  function ensureSpace(lines: number) {
    if (y + lines * 16 > pageHeight - 48) {
      doc.addPage();
      y = 56;
    }
  }

  function writeWrapped(label: string, value: string) {
    const lines: string[] = doc.splitTextToSize(
      `${label}: ${value.trim() || "—"}`,
      pageWidth - marginX * 2,
    );
    ensureSpace(lines.length);
    doc.text(lines, marginX, y);
    y += lines.length * 15;
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("Orden de impresión", marginX, y);
  y += 22;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text(`Folio: ${folio}`, marginX, y);
  y += 16;
  doc.text(`Producto: ${product.nombre} (${product.codigo})`, marginX, y);
  y += 16;
  doc.text(`Fecha: ${new Date().toLocaleDateString("es-MX")}`, marginX, y);
  y += 24;

  for (const entry of entries) {
    ensureSpace(4);
    doc.setDrawColor(200);
    doc.line(marginX, y, pageWidth - marginX, y);
    y += 18;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(entry.item.nombre || "(sin nombre)", marginX, y);
    y += 18;

    doc.setFontSize(10.5);
    ensureSpace(1);
    doc.text(`Total de tamaños a imprimir con merma: ${entry.totalPliegos}`, marginX, y);
    y += 15;
    doc.text(`Total de cambios a imprimir: ${entry.totalPorPliego}`, marginX, y);
    y += 18;

    doc.setFont("helvetica", "normal");
    doc.text(`Merma: ${entry.merma}`, marginX, y);
    y += 15;
    doc.text(`Cantidad de arte: ${entry.cantidadArte}`, marginX, y);
    y += 15;
    doc.text(`Número de tiros: ${entry.numeroTiros}`, marginX, y);
    y += 15;

    for (const campo of CAMPOS) {
      ensureSpace(1);
      doc.text(`${campo.label}: ${campo.get(entry.item) || "—"}`, marginX, y);
      y += 15;
    }

    const procesos = PROCESOS_ORDEN_PDF.filter((nombre) =>
      entry.item.checks.some((c) => c.nombre === nombre && c.marcado),
    ).join(", ");
    ensureSpace(1);
    doc.text(`Procesos: ${procesos || "—"}`, marginX, y);
    y += 15;

    writeWrapped("Acabados", entry.item.acabados);
    writeWrapped("Notas", entry.item.notas);
    y += 8;
  }

  return new Uint8Array(doc.output("arraybuffer"));
}

export async function buildPurchasePdf(
  product: Product,
  entries: PurchaseEntry[],
  folio: string,
): Promise<Uint8Array> {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const marginX = 48;
  const pageHeight = doc.internal.pageSize.getHeight();
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 56;
  await drawLogo(doc, marginX, pageWidth);

  function ensureSpace(lines: number) {
    if (y + lines * 16 > pageHeight - 48) {
      doc.addPage();
      y = 56;
    }
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("Orden de compra", marginX, y);
  y += 22;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text(`Folio: ${folio}`, marginX, y);
  y += 16;
  doc.text(`Producto: ${product.nombre} (${product.codigo})`, marginX, y);
  y += 16;
  doc.text(`Fecha: ${new Date().toLocaleDateString("es-MX")}`, marginX, y);
  y += 24;

  for (const entry of entries) {
    ensureSpace(9);
    doc.setDrawColor(200);
    doc.line(marginX, y, pageWidth - marginX, y);
    y += 18;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(entry.item.nombre || "(sin nombre)", marginX, y);
    y += 18;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10.5);
    doc.text(
      `Total de tamaños a imprimir con merma (orden base): ${entry.baseOrder.total_pliegos}`,
      marginX,
      y,
    );
    y += 22;

    doc.setFont("helvetica", "bold");
    doc.text(`Cantidad: ${entry.cantidad}`, marginX, y);
    y += 15;

    doc.setFont("helvetica", "normal");
    doc.text(`Papel: ${entry.papel || "—"}`, marginX, y);
    y += 15;
    doc.text(`Pliego: ${entry.pliego || "—"}`, marginX, y);
    y += 15;
    doc.text(`Cortes: ${entry.cortes}`, marginX, y);
    y += 15;
    doc.text(`Máquina: ${entry.maquina || "—"}`, marginX, y);
    y += 15;
    doc.text(`Gramos o puntos: ${entry.item.gramos_puntos || "—"}`, marginX, y);
    y += 15;

    doc.setFont("helvetica", "bold");
    doc.text(`Total de tamaños: ${entry.totalTamanos}`, marginX, y);
    doc.setFont("helvetica", "normal");
    y += 22;
  }

  return new Uint8Array(doc.output("arraybuffer"));
}

export interface RequisicionPdfEntry {
  folio: string;
  cantidad: number;
  etiqueta: string;
}

export async function buildRequisicionPdf(
  product: Product,
  entry: RequisicionPdfEntry,
): Promise<Uint8Array> {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const marginX = 48;
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 56;
  await drawLogo(doc, marginX, pageWidth);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("Requisición de material", marginX, y);
  y += 22;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text(`Folio: ${entry.folio}`, marginX, y);
  y += 16;
  doc.text(`Fecha: ${new Date().toLocaleDateString("es-MX")}`, marginX, y);
  y += 16;

  doc.setDrawColor(200);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 22;

  doc.setFontSize(10.5);
  doc.text(`Cantidad: ${entry.cantidad}`, marginX, y);
  y += 15;
  doc.text(entry.etiqueta || "—", marginX, y);
  y += 15;
  doc.text(`Nombre del juego: ${product.nombre}`, marginX, y);
  y += 15;
  doc.text(`SKU: ${product.codigo}`, marginX, y);

  return new Uint8Array(doc.output("arraybuffer"));
}

// --- Remisión (plantilla Assets/remision.pdf, rasterizada como fondo) ---

interface RemisionTemplate {
  img: HTMLImageElement;
  w: number;
  h: number;
}

let remisionTemplatePromise: Promise<RemisionTemplate | null> | null = null;

function getRemisionTemplate(): Promise<RemisionTemplate | null> {
  if (!remisionTemplatePromise) {
    remisionTemplatePromise = (async () => {
      try {
        const img = new Image();
        img.src = remisionTemplateUrl;
        await img.decode();
        return { img, w: img.naturalWidth, h: img.naturalHeight };
      } catch (err) {
        console.warn("No se pudo cargar la plantilla de remisión:", err);
        return null;
      }
    })();
  }
  return remisionTemplatePromise;
}

// Tamaño real de la plantilla (MediaBox de Assets/remision.pdf), no "letter".
const REMISION_PAGE_WIDTH = 595.5;
const REMISION_PAGE_HEIGHT = 842.25;

// Coordenadas medidas en px sobre el raster original (1696×2400) de
// Assets/remision-template.png y convertidas a pt (escala 595.5/1696).
const REMISION_ROWS_PER_PAGE = 15;
const REMISION_FIRST_ROW_Y = 279.0;
const REMISION_ROW_HEIGHT = 28.4;

const REMISION_FOLIO_X = 525.0;
const REMISION_FOLIO_Y = 176.5;
const REMISION_FECHA_X = 372.9;
const REMISION_FECHA_Y = 220.4;
const REMISION_PEDIDO_X = 520.4;
const REMISION_PEDIDO_Y = 220.4;

// Rectángulos blancos para tapar los valores de ejemplo (XXXXXX/DD-MM-AA/
// JALISCO) horneados en la plantilla original antes de escribir el valor real.
const REMISION_ERASE_FOLIO: [number, number, number, number] = [493, 160, 62, 22];
const REMISION_ERASE_FECHA: [number, number, number, number] = [326, 205, 95, 20];
const REMISION_ERASE_PEDIDO: [number, number, number, number] = [493, 205, 56, 22];
// El valor de "Precio en texto" no viene horneado en la plantilla (a
// diferencia de folio/fecha/pedido), pero igual se tapa con blanco antes de
// escribir el generado — por si queda una versión previa dibujada debajo en
// algún reintento, nunca debe mezclarse con la anterior.
const REMISION_ERASE_PRECIO_TEXTO: [number, number, number, number] = [10, 716, 415, 50];

const REMISION_COL_CLAVE_X = 45.6;
const REMISION_COL_CANTIDAD_X = 101.8;
const REMISION_COL_PRODUCTO_X = 140.4;
const REMISION_COL_PRODUCTO_WIDTH = 279.1;
// Un poco más a la izquierda del borde de la columna para que precios de 4-5
// cifras no se salgan del recuadro impreso.
const REMISION_COL_PRECIO_X = 468;
const REMISION_COL_IMPORTE_X = 565.3;

const REMISION_PRECIO_TEXTO_X = 15.8;
const REMISION_PRECIO_TEXTO_Y = 728.4;
const REMISION_PRECIO_TEXTO_WIDTH = 404;
const REMISION_TOTALES_X = 565.3;
const REMISION_SUBTOTAL_Y = 708.3;
const REMISION_DESCUENTO_PCT_Y = 717.7;
const REMISION_DESCUENTO_Y = 727.2;
const REMISION_IVA_Y = 737.0;
const REMISION_TOTAL_Y = 763.5;

// El renglón solo tiene una línea de alto — un nombre de producto que no
// quepa se corta con "…" en vez de perder texto sin ningún indicio visible
// en un documento impreso/legal como la remisión.
function truncateToWidth(doc: jsPDF, text: string, maxWidth: number): string {
  if (doc.getTextWidth(text) <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 0 && doc.getTextWidth(`${truncated}…`) > maxWidth) {
    truncated = truncated.slice(0, -1).trimEnd();
  }
  return `${truncated}…`;
}

function formatFechaRemision(fechaIso: string): string {
  const [y, m, d] = fechaIso.split("-");
  return `${d}/${m}/${y}`;
}

export async function buildRemisionPdf(
  remision: Remision,
  renglones: RemisionRenglon[],
): Promise<Uint8Array> {
  const template = await getRemisionTemplate();
  const doc = new jsPDF({ unit: "pt", format: [REMISION_PAGE_WIDTH, REMISION_PAGE_HEIGHT] });

  function drawBackground() {
    if (!template) return;
    doc.addImage(template.img, "PNG", 0, 0, REMISION_PAGE_WIDTH, REMISION_PAGE_HEIGHT);
  }

  const totalPages = Math.max(1, Math.ceil(renglones.length / REMISION_ROWS_PER_PAGE));

  for (let page = 0; page < totalPages; page++) {
    if (page > 0) doc.addPage();
    drawBackground();

    // El folio/fecha/pedido se repiten en cada página (no solo la primera) —
    // un documento de varias páginas debe poder identificarse completo aunque
    // se separen las hojas.
    doc.setFillColor(255, 255, 255);
    doc.rect(...REMISION_ERASE_FOLIO, "F");
    doc.rect(...REMISION_ERASE_FECHA, "F");
    doc.rect(...REMISION_ERASE_PEDIDO, "F");

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.text(remision.folio, REMISION_FOLIO_X, REMISION_FOLIO_Y, { align: "center" });
    doc.setFont("helvetica", "normal");
    doc.text(formatFechaRemision(remision.fecha), REMISION_FECHA_X, REMISION_FECHA_Y, {
      align: "center",
    });
    doc.text(remision.pedido_bodegas || "—", REMISION_PEDIDO_X, REMISION_PEDIDO_Y, {
      align: "center",
    });

    const pageRows = renglones.slice(page * REMISION_ROWS_PER_PAGE, (page + 1) * REMISION_ROWS_PER_PAGE);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    pageRows.forEach((renglon, i) => {
      const y = REMISION_FIRST_ROW_Y + i * REMISION_ROW_HEIGHT;
      doc.text(renglon.sku, REMISION_COL_CLAVE_X, y, { align: "center" });
      doc.text(String(renglon.cantidad), REMISION_COL_CANTIDAD_X, y, { align: "center" });
      const producto = truncateToWidth(doc, renglon.producto_nombre, REMISION_COL_PRODUCTO_WIDTH);
      doc.text(producto, REMISION_COL_PRODUCTO_X, y);
      doc.text(formatMoney(renglon.precio_unitario), REMISION_COL_PRECIO_X, y, { align: "right" });
      doc.text(formatMoney(renglon.importe), REMISION_COL_IMPORTE_X, y, { align: "right" });
    });

    if (page === totalPages - 1) {
      doc.setFillColor(255, 255, 255);
      doc.rect(...REMISION_ERASE_PRECIO_TEXTO, "F");
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.text(remision.precio_texto, REMISION_PRECIO_TEXTO_X, REMISION_PRECIO_TEXTO_Y, {
        maxWidth: REMISION_PRECIO_TEXTO_WIDTH,
      });

      doc.setFontSize(10);
      doc.text(formatMoney(remision.subtotal), REMISION_TOTALES_X, REMISION_SUBTOTAL_Y, { align: "right" });
      doc.text(`${remision.descuento_pct}%`, REMISION_TOTALES_X, REMISION_DESCUENTO_PCT_Y, { align: "right" });
      doc.text(formatMoney(remision.descuento), REMISION_TOTALES_X, REMISION_DESCUENTO_Y, { align: "right" });
      doc.text(formatMoney(remision.iva), REMISION_TOTALES_X, REMISION_IVA_Y, { align: "right" });
      doc.setFont("helvetica", "bold");
      doc.text(formatMoney(remision.total), REMISION_TOTALES_X, REMISION_TOTAL_Y, { align: "right" });
    }
  }

  return new Uint8Array(doc.output("arraybuffer"));
}
