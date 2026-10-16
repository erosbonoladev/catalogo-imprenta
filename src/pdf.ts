import { jsPDF } from "jspdf";
import type { PrintItem, PrintItemOrder, Product, Remision, RemisionRenglon, TipoRemision } from "./types";
import corporateLogoUrl from "../Assets/perspectiva.jpeg";
import remisionTemplateUrl from "../Assets/remision-template.png";
import remisionTemplateExternaUrl from "../Assets/remision-template-externa.png";
import { formatMoney } from "./excelExport";
import * as L from "./remisionLayout";

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
        img.src = corporateLogoUrl;
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
  doc.addImage(logo.img, "JPEG", pageWidth - marginX - drawW, 28, drawW, drawH);
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
  fecha?: Date,
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
  doc.text(`Fecha: ${(fecha ?? new Date()).toLocaleDateString("es-MX")}`, marginX, y);
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
    doc.text(`Total por cambios a Imprimir: ${entry.totalPorPliego}`, marginX, y);
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
  fecha?: Date,
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
  doc.text(`Fecha: ${(fecha ?? new Date()).toLocaleDateString("es-MX")}`, marginX, y);
  y += 24;

  for (const entry of entries) {
    ensureSpace(8);
    doc.setDrawColor(200);
    doc.line(marginX, y, pageWidth - marginX, y);
    y += 18;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(entry.item.nombre || "(sin nombre)", marginX, y);
    y += 18;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10.5);

    doc.text(`Cantidad: ${entry.cantidad}`, marginX, y);
    y += 15;
    doc.text(`Papel: ${entry.papel || "—"}`, marginX, y);
    y += 15;
    doc.text(`Gramos o puntos: ${entry.item.gramos_puntos || "—"}`, marginX, y);
    y += 15;
    doc.text(`Pliego: ${entry.pliego || "—"}`, marginX, y);
    y += 15;
    doc.text(`Cortes: ${entry.cortes}`, marginX, y);
    y += 15;
    doc.text(`Máquina: ${entry.maquina || "—"}`, marginX, y);
    y += 15;
    doc.text(`Total de tamaños a imprimir: ${entry.totalTamanos}`, marginX, y);
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

const remisionTemplatePromises = new Map<string, Promise<RemisionTemplate | null>>();

function getRemisionTemplate(tipo: TipoRemision): Promise<RemisionTemplate | null> {
  const url = tipo === "externa" ? remisionTemplateExternaUrl : remisionTemplateUrl;
  let promise = remisionTemplatePromises.get(url);
  if (!promise) {
    promise = (async () => {
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return { img, w: img.naturalWidth, h: img.naturalHeight };
      } catch (err) {
        console.warn("No se pudo cargar la plantilla de remisión:", err);
        return null;
      }
    })();
    remisionTemplatePromises.set(url, promise);
  }
  return promise;
}

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

// Reduce el tamaño de letra (en vez de truncar, a diferencia de
// truncateToWidth) hasta que el folio entre en el ancho disponible — a
// diferencia de un nombre de producto, el folio es un identificador legal del
// documento y no debe perder caracteres.
function fitFolioFontSize(doc: jsPDF, text: string, maxWidth: number, startSize: number, minSize: number): number {
  doc.setFont("helvetica", "bold");
  return fitFontSize(doc, text, maxWidth, startSize, minSize);
}

// Igual para el nombre del cliente/bodega, que es texto libre (con la fuente ya seleccionada).
function fitFontSize(doc: jsPDF, text: string, maxWidth: number, startSize: number, minSize: number): number {
  let size = startSize;
  doc.setFontSize(size);
  while (size > minSize && doc.getTextWidth(text) > maxWidth) {
    size -= 0.5;
    doc.setFontSize(size);
  }
  return size;
}

export async function buildRemisionPdf(
  remision: Remision,
  renglones: RemisionRenglon[],
): Promise<Uint8Array> {
  const template = await getRemisionTemplate(remision.tipo);
  const doc = new jsPDF({ unit: "pt", format: [L.PAGE_W, L.PAGE_H] });
  const externa = remision.tipo === "externa";
  const C = L.columnsFor(remision.tipo);

  function drawBackground() {
    if (!template) return;
    doc.addImage(template.img, "PNG", 0, 0, L.PAGE_W, L.PAGE_H);
  }

  function erase(rect: L.Rect) {
    doc.setFillColor(255, 255, 255);
    doc.rect(rect[0], rect[1], rect[2], rect[3], "F");
  }

  const totalPages = Math.max(1, Math.ceil(renglones.length / L.ROWS_PER_PAGE));
  const folio = L.folioImpreso(remision.folio);
  const folioFontSize = fitFolioFontSize(doc, folio, L.FOLIO.maxWidth, 10.5, 6);
  const pedido = remision.pedido_bodegas || "—";
  doc.setFont("helvetica", "normal");
  const pedidoFontSize = fitFontSize(doc, pedido, L.PEDIDO.maxWidth, L.FONT_HEADER_FIELD, 6);

  for (let page = 0; page < totalPages; page++) {
    if (page > 0) doc.addPage();
    drawBackground();

    // El folio/fecha/pedido se repiten en cada página (no solo la primera) —
    // un documento de varias páginas debe poder identificarse completo aunque
    // se separen las hojas.
    erase(L.FOLIO.erase);
    erase(L.FECHA.erase);
    if (!externa) erase(L.PEDIDO.erase);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(folioFontSize);
    doc.text(folio, L.FOLIO.cx, L.FOLIO.cy, { align: "center", baseline: "middle" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(L.FONT_HEADER_FIELD);
    doc.text(L.formatFechaHoja(remision.fecha), L.FECHA.cx, L.FECHA.cy, { align: "center", baseline: "middle" });

    if (externa) {
      // Bloque de datos del cliente (la plantilla externa no trae el de Bodegas Educativas).
      const blk = L.CLIENTE_BLOCK;
      const valores: Record<L.ClienteCampo, string> = {
        cliente: remision.pedido_bodegas,
        rfc: remision.cliente_rfc,
        direccion: remision.cliente_direccion,
        contacto: remision.cliente_contacto,
        telefono: remision.cliente_telefono,
      };
      blk.fields.forEach(({ campo, label }, i) => {
        const cy = blk.firstCy + i * blk.pitch;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(L.FONT_BODY);
        doc.text(label, blk.labelX, cy, { baseline: "middle" });
        const valor = valores[campo];
        if (!valor) return;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(fitFontSize(doc, valor, blk.valueMaxWidth, L.FONT_BODY, 6));
        doc.text(valor, blk.valueX, cy, { baseline: "middle" });
      });
    } else {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(pedidoFontSize);
      doc.text(pedido, L.PEDIDO.cx, L.PEDIDO.cy, { align: "center", baseline: "middle" });
    }

    const pageRows = renglones.slice(page * L.ROWS_PER_PAGE, (page + 1) * L.ROWS_PER_PAGE);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(L.FONT_BODY);
    pageRows.forEach((renglon, i) => {
      const y = L.rowCenterY(i);
      const mid = { baseline: "middle" } as const;
      // La clave es información interna: la plantilla externa no tiene esa columna.
      if (C.clave) doc.text(renglon.sku, (C.clave[0] + C.clave[1]) / 2, y, { align: "center", ...mid });
      doc.text(String(renglon.cantidad), (C.cantidad[0] + C.cantidad[1]) / 2, y, { align: "center", ...mid });
      const producto = truncateToWidth(doc, renglon.producto_nombre, C.producto[1] - 4 - C.productoTextX);
      doc.text(producto, C.productoTextX, y, mid);
      doc.text(formatMoney(renglon.precio_unitario), C.precioTextRight, y, { align: "right", ...mid });
      doc.text(formatMoney(renglon.importe), C.importeTextRight, y, { align: "right", ...mid });
    });

    if (page === totalPages - 1) {
      const pt = L.PRECIO_TEXTO;
      erase([pt.x - 1, pt.y - 1, pt.w + 2, pt.h]);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.text(remision.precio_texto, pt.x, pt.y + 5, { maxWidth: pt.w, baseline: "middle", lineHeightFactor: pt.lineHeight / 9 });

      doc.setFontSize(L.FONT_TOTALES);
      const right = { align: "right", baseline: "middle" } as const;
      doc.text(formatMoney(remision.subtotal), L.TOTALES_RIGHT, L.TOTAL_CY.subtotal, right);
      doc.text(`${remision.descuento_pct}%`, L.TOTALES_RIGHT, L.TOTAL_CY.descuentoPct, right);
      doc.text(formatMoney(remision.descuento), L.TOTALES_RIGHT, L.TOTAL_CY.descuento, right);
      doc.text(formatMoney(remision.iva), L.TOTALES_RIGHT, L.TOTAL_CY.iva, right);
      doc.setFont("helvetica", "bold");
      doc.text(formatMoney(remision.total), L.TOTALES_RIGHT, L.TOTAL_CY.total, right);
    }
  }

  return new Uint8Array(doc.output("arraybuffer"));
}
