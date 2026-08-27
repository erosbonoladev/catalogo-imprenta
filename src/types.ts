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
  presentacion_original: string;
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

export interface PlasticProduct {
  id: number;
  nombre: string;
  sku: string;
  color: string;
  origen: string;
  descripcion: string;
  armado: string;
  dimension: string;
  peso: string;
  tipo_empaque: string;
  imagen: ImageBlob | null;
  imagen_codigo_barras: ImageBlob | null;
  creado_en: string;
}

export interface PlasticProductInput {
  nombre: string;
  sku: string;
  color: string;
  origen: string;
  descripcion: string;
  armado: string;
  dimension: string;
  peso: string;
  tipo_empaque: string;
  imagen: ImageBlob | null;
  imagen_codigo_barras: ImageBlob | null;
}

export interface PlasticItem {
  id?: number;
  product_id?: number;
  plastic_product_id: number | null;
  orden: number;
  data: PlasticProductInput;
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

export interface PrintItemImage {
  id?: number;
  print_item_id?: number;
  imagen: ImageBlob;
  orden: number;
}

export const PROCESOS_IMPRENTA = [
  "Suaje",
  "Guillotina",
  "Plástico",
  "Barniz UV",
  "Barniz de máquina",
] as const;

export type PlacasExistentes = "" | "si" | "no";

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
  numero_placas: string;
  placas_existentes: PlacasExistentes;
  checks: PrintItemCheck[];
  extras: PrintItemExtra[];
  images: PrintItemImage[];
  acabados: string;
  notas: string;
  orden: number;
}

export interface PrintItemOrder {
  id: number;
  print_item_id: number;
  merma: number;
  cantidad_arte: number;
  numero_tiros: number | null;
  formacion_usada: number;
  numero_pliegos_usado: number;
  total_pliegos: number;
  usuario: string | null;
  folio: string;
  creado_en: string;
}

export interface PrintItemPurchase {
  id: number;
  print_item_order_id: number;
  papel: string;
  pliego: string;
  maquina: string;
  cortes: number;
  cantidad: number;
  total_tamanos: number;
  usuario: string | null;
  folio: string;
  creado_en: string;
}

export type SearchFilter = "todo" | "nombre" | "sku" | "material";

export const PERMISOS = ["plasticos", "imprenta", "configuraciones"] as const;
export type Permiso = (typeof PERMISOS)[number];

export const PERMISO_LABELS: Record<Permiso, string> = {
  plasticos: "Piezas",
  imprenta: "Imprenta",
  configuraciones: "Configuraciones",
};

export type Rol = "usuario" | "admin";

export interface User {
  id: number;
  username: string;
  activo: boolean;
  rol: Rol;
  permisos: Permiso[];
  creado_en: string;
}

export interface UserInput {
  username: string;
  password?: string;
  activo: boolean;
  rol: Rol;
  permisos: Permiso[];
}

export type LogLevel = "INFO" | "WARNING" | "ERROR";

export interface AppLog {
  id: number;
  nivel: LogLevel;
  mensaje: string;
  usuario: string | null;
  creado_en: string;
}

export interface ConnectedUser {
  id: number;
  username: string;
  last_seen: string;
}

export const ESTADOS_REQUISICION = [
  "pendiente",
  "confirmada",
  "surtida",
  "parcial",
  "cancelada",
] as const;
export type EstadoRequisicion = (typeof ESTADOS_REQUISICION)[number];

export interface Requisicion {
  id: number;
  product_id: number;
  fecha: string;
  numero_dia: number;
  usuario: string | null;
  etiqueta: string;
  descripcion: string;
  cantidad: number;
  estado: EstadoRequisicion;
  mensaje: string;
  folio: string;
  creado_en: string;
}

export interface RequisicionInput {
  productId: number;
  productNombre: string;
  productCodigo: string;
  etiqueta: string;
  descripcion: string;
  cantidad: number;
  usuario: string | null;
  folio: string;
}

export type TipoFolio = "requisicion" | "compra" | "produccion";

export interface Folio {
  id: number;
  seccion: TipoFolio;
  consecutivo: number;
  folio: string;
  sku: string;
  creado_en: string;
}
