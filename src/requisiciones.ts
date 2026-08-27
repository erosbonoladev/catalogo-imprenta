// Configuración central para requisiciones de material a bodega vía WhatsApp.
// El número vive en una sola variable de entorno (ver .env.example) para no
// quedar repetido/hardcodeado en distintas partes del código.
export const WHATSAPP_BODEGA_NUMBER: string =
  import.meta.env.VITE_WHATSAPP_BODEGA_NUMBER ?? "";

export function buildRequisicionMessage(
  numeroDia: number,
  cantidad: number,
  etiqueta: string,
  productNombre: string,
  productCodigo: string,
): string {
  const linea = `${cantidad} - ${etiqueta} de ${productNombre} - ${productCodigo}`;
  if (numeroDia <= 1) {
    return [
      "Buen día, equipo de bodega.",
      "",
      "Espero que se encuentren bien. Solicito de su apoyo con el despacho del siguiente material:",
      "",
      `* ${linea}`,
      "",
      "Quedo atento a la confirmación de disponibilidad y hora exacta de recolección.",
      "",
      "Saludos cordiales.",
    ].join("\n");
  }
  return [
    `Requisición adicional #${numeroDia}`,
    "",
    "Estimados, buen día.",
    "",
    "Requiero solicitar un surtido adicional para el área.",
    "",
    "* Material requerido:",
    "",
    `  * ${linea}`,
    "",
    "Agradezco de antemano su apoyo para gestionar este requerimiento.",
    "",
    "Quedo a la espera de su confirmación.",
  ].join("\n");
}

export function buildWhatsAppUrl(mensaje: string): string {
  return `https://wa.me/${WHATSAPP_BODEGA_NUMBER}?text=${encodeURIComponent(mensaje)}`;
}
