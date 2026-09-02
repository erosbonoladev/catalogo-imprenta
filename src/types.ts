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
  actualizado_en: string;
}

export interface ProductSpec {
  id?: number;
  product_id?: number;
  etiqueta: string;
  valor: string;
  orden: number;
  permite_requisicion: boolean;
}

export interface ProductDescription {
  id?: number;
  product_id?: number;
  etiqueta: string;
  texto: string;
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

export const PERMISOS = [
  "plasticos",
  "imprenta",
  "configuraciones",
  "requisiciones",
  "backups_ver",
  "backups_crear",
  "backups_descargar",
  "backups_restaurar",
  "backups_configurar",
  "backups_eliminar",
  "precios_ver",
  "precios_modificar",
  "remisiones_acceso",
  "remisiones_crear",
  "remisiones_cancelar",
] as const;
export type Permiso = (typeof PERMISOS)[number];

export const PERMISO_LABELS: Record<Permiso, string> = {
  plasticos: "Piezas",
  imprenta: "Imprenta",
  configuraciones: "Configuraciones",
  requisiciones: "Requisiciones",
  backups_ver: "Backups: ver",
  backups_crear: "Backups: crear manual",
  backups_descargar: "Backups: descargar",
  backups_restaurar: "Backups: restaurar",
  backups_configurar: "Backups: configurar programación",
  backups_eliminar: "Backups: eliminar",
  precios_ver: "Precios: ver",
  precios_modificar: "Precios: modificar",
  remisiones_acceso: "Remisiones: acceso",
  remisiones_crear: "Remisiones: crear",
  remisiones_cancelar: "Remisiones: borrar",
};

export const PERMISOS_BACKUPS: Permiso[] = [
  "backups_ver",
  "backups_crear",
  "backups_descargar",
  "backups_restaurar",
  "backups_configurar",
  "backups_eliminar",
];

export const BACKUP_TIPOS = [
  "BACKUP_AUTOMATICO",
  "BACKUP_MANUAL",
  "BACKUP_PRE_IMPORTACION",
  "BACKUP_PRE_RESTAURACION",
  "RESTAURACION",
  "RESTAURACION_ARCHIVO_SUBIDO",
  "CONFIGURACION_CAMBIADA",
] as const;
export type BackupTipo = (typeof BACKUP_TIPOS)[number];

export type BackupEstado = "EN_PROCESO" | "EXITOSO" | "FALLIDO";

export interface BackupRecord {
  id: number;
  tipo: BackupTipo;
  origen: string;
  usuario: string | null;
  archivo: string;
  ubicacion: string;
  tamano_bytes: number;
  checksum_sha256: string;
  estado: BackupEstado;
  detalle: string;
  creado_en: string;
}

export interface BackupManifest {
  version: 1;
  creadoEn: string;
  tablas: Record<string, number>;
}

export type BackupFrecuencia = "diario" | "cada_n_horas" | "semanal";

export interface BackupSettings {
  automatico_activado: boolean;
  frecuencia: BackupFrecuencia;
  hora_ejecucion: string;
  intervalo_horas: number | null;
  dia_semana: number | null;
  retencion_diaria_dias: number;
  retencion_semanal_dias: number;
  retencion_mensual_dias: number;
  ultimo_automatico_en: string | null;
  actualizado_en: string;
  actualizado_por: string | null;
}

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

export type TipoFolio = "requisicion" | "compra" | "produccion" | "remision";

export interface Folio {
  id: number;
  seccion: TipoFolio;
  consecutivo: number;
  folio: string;
  sku: string;
  creado_en: string;
}

// --- Precios ---

export type TipoPrecio = "interno" | "externo";

export interface Precio {
  id: number;
  sku: string;
  sku_principal: string;
  nombre: string;
  precio: number;
  actualizado_en: string;
  actualizado_por: string | null;
  creado_en: string;
  // NULL = productos guardados antes de esta clasificación — se tratan como
  // "interno" en la exportación (ver excelExport.ts), nunca como "externo".
  tipo: TipoPrecio | null;
}

export interface PrecioInput {
  sku: string;
  nombre: string;
  precio: number;
  usuario: string | null;
  // Opcional: si se omite al actualizar un precio existente, upsertPrecio()
  // conserva la clasificación que ya tenía (ver COALESCE en su query) — no
  // reclasifica accidentalmente un producto por una simple edición de precio.
  tipo?: TipoPrecio;
}

export interface PrecioHistorialEntry {
  id: number;
  sku: string;
  precio_anterior: number | null;
  precio_nuevo: number;
  usuario: string | null;
  creado_en: string;
}

// --- Remisiones ---

export type TipoRemision = "interna" | "externa";

export interface Remision {
  id: number;
  folio: string;
  fecha: string;
  tipo: TipoRemision;
  pedido_bodegas: string;
  cancelada: boolean;
  subtotal: number;
  descuento_pct: number;
  descuento: number;
  iva: number;
  total: number;
  precio_texto: string;
  usuario: string | null;
  creado_en: string;
}

export interface RemisionRenglon {
  id: number;
  remision_id: number;
  numero_renglon: number;
  sku: string;
  producto_nombre: string;
  cantidad: number;
  precio_unitario: number;
  importe: number;
}

export interface RemisionRenglonInput {
  sku: string;
  producto_nombre: string;
  cantidad: number;
  precio_unitario: number;
  importe: number;
}

export interface RemisionInput {
  folio: string;
  fecha: string;
  tipo: TipoRemision;
  pedido_bodegas: string;
  subtotal: number;
  descuento_pct: number;
  descuento: number;
  iva: number;
  total: number;
  precio_texto: string;
  usuario: string | null;
}

export interface RemisionConRenglones extends Remision {
  renglones: RemisionRenglon[];
}

export interface RemisionHistorialRow {
  fecha: string;
  folio: string;
  pedido_bodegas: string;
  cancelada: boolean;
  numero_renglon: number;
  sku: string;
  cantidad: number;
  producto_nombre: string;
  precio_unitario: number;
  importe: number;
  subtotal: number;
  descuento_pct: number;
  descuento: number;
  iva: number;
  total: number;
}
