// Lógica centralizada del sistema de folios (AAA-SKU-DDMMYY-00001) usado por
// todos los PDFs de la app. La generación atómica del consecutivo vive en
// db.ts (createFolio) — este archivo solo contiene lógica pura reutilizable
// por db.ts y por los componentes que arman el string a mostrar/usar.
import type { TipoFolio } from "./types";

export const FOLIO_PREFIJOS: Record<TipoFolio, string> = {
  requisicion: "REQ",
  compra: "COM",
  produccion: "PRO",
};

// Fecha local (día del taller, no UTC) — movida aquí desde db.ts para que
// requisiciones.numero_dia y los folios compartan la misma noción de "hoy".
export function fechaLocalDeHoy(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function formatFechaFolioLocal(fechaISO: string = fechaLocalDeHoy()): string {
  const [y, m, d] = fechaISO.split("-");
  return `${d}${m}${y.slice(2)}`;
}

function sanitizeFolioComponent(text: string): string {
  return text.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "SKU";
}

export function buildFolioString(
  prefix: string,
  sku: string,
  fechaDDMMYY: string,
  consecutivo: number,
): string {
  return `${prefix}-${sanitizeFolioComponent(sku)}-${fechaDDMMYY}-${String(consecutivo).padStart(5, "0")}`;
}
