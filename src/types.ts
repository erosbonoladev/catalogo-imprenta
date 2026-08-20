export interface ImageBlob {
  data: Uint8Array;
  mime: string;
}

export interface Product {
  id: number;
  codigo: string;
  nombre: string;
  categoria: string;
  material: string;
  descripcion: string;
  imagen: ImageBlob | null;
  creado_en: string;
}

export interface ProductSpec {
  id?: number;
  product_id?: number;
  etiqueta: string;
  valor: string;
  orden: number;
}

export interface ProductInput {
  codigo: string;
  nombre: string;
  categoria: string;
  material: string;
  descripcion: string;
  imagen: ImageBlob | null;
}

export interface PlasticPiece {
  id?: number;
  product_id?: number;
  sku: string;
  color: string;
  imagen: ImageBlob | null;
  orden: number;
}

export interface PrintItemCheck {
  id?: number;
  print_item_id?: number;
  nombre: string;
  marcado: boolean;
  orden: number;
}

export interface PrintItemExtra {
  id?: number;
  print_item_id?: number;
  etiqueta: string;
  valor: string;
  orden: number;
}

export const PROCESOS_IMPRENTA = [
  "Suaje",
  "Guillotina",
  "Plástico",
  "Barniz UV",
  "Barniz de máquina",
] as const;

export interface PrintItem {
  id?: number;
  product_id?: number;
  nombre: string;
  tamano_extendido: string;
  tamano_final: string;
  tintas: string;
  tipo_papel: string;
  gramos_puntos: string;
  pliego: string;
  cortes_tamano: string;
  maquina: string;
  formacion: string;
  numero_pliegos: string;
  checks: PrintItemCheck[];
  extras: PrintItemExtra[];
  acabados: string;
  notas: string;
  orden: number;
}

export const SECCION_PLASTICOS = "plasticos";
export const SECCION_IMPRENTA = "imprenta";
export const SECCION_ADMIN = "admin";
