import { jsPDF } from "jspdf";
import type { PrintItem, Product } from "./types";

export interface OrderEntry {
  item: PrintItem;
  merma: number;
  cantidadArte: number;
  totalPliegos: number;
}

const CAMPOS: { label: string; get: (item: PrintItem) => string }[] = [
  { label: "Tamaño extendido", get: (i) => i.tamano_extendido },
  { label: "Tamaño final", get: (i) => i.tamano_final },
  { label: "Tintas", get: (i) => i.tintas },
  { label: "Tipo de papel", get: (i) => i.tipo_papel },
  { label: "Gramos o puntos", get: (i) => i.gramos_puntos },
  { label: "Máquina", get: (i) => i.maquina },
  { label: "Formación", get: (i) => i.formacion },
  { label: "Número de pliegos", get: (i) => i.numero_pliegos },
];

export function buildOrderPdf(product: Product, entries: OrderEntry[]): Uint8Array {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const marginX = 48;
  const pageHeight = doc.internal.pageSize.getHeight();
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 56;

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

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10.5);
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

    ensureSpace(3);
    doc.text(`Merma: ${entry.merma}`, marginX, y);
    y += 15;
    doc.text(`Cantidad de arte: ${entry.cantidadArte}`, marginX, y);
    y += 15;
    doc.setFont("helvetica", "bold");
    doc.text(`Total de pliegos a imprimir: ${entry.totalPliegos}`, marginX, y);
    doc.setFont("helvetica", "normal");
    y += 22;
  }

  return new Uint8Array(doc.output("arraybuffer"));
}
