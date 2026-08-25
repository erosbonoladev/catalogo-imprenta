import { jsPDF } from "jspdf";
import type { PrintItem, PrintItemOrder, Product } from "./types";
import perspectivaUrl from "../Assets/perspectiva.jpeg";

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
        img.src = perspectivaUrl;
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

export async function buildOrderPdf(product: Product, entries: OrderEntry[]): Promise<Uint8Array> {
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
    doc.text(`Total de tamaños por pliego a imprimir: ${entry.totalPorPliego}`, marginX, y);
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

    const procesos = entry.item.checks
      .filter((c) => c.marcado)
      .map((c) => c.nombre)
      .join(", ");
    ensureSpace(1);
    doc.text(`Procesos: ${procesos || "—"}`, marginX, y);
    y += 15;

    writeWrapped("Acabados", entry.item.acabados);
    writeWrapped("Notas", entry.item.notas);
    y += 8;
  }

  return new Uint8Array(doc.output("arraybuffer"));
}

export async function buildPurchasePdf(product: Product, entries: PurchaseEntry[]): Promise<Uint8Array> {
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
