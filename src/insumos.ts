// Un insumo se identifica por su SKU INS-NNNN (cuatro dígitos). El número lo
// asigna siempre la base (siguiente libre, ver INSUMO_SKU_SIGUIENTE_SQL en
// db.ts), nunca el usuario.
export const INSUMO_SKU_PREFIJO = "INS-";

const INSUMO_SKU_RE = /^INS-\d{4}$/;

export function isInsumoSku(sku: string): boolean {
  return INSUMO_SKU_RE.test(sku.trim());
}
