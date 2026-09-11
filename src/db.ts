import { createClient, type Client, type Transaction } from "@libsql/client/web";
import { open, save } from "@tauri-apps/plugin-dialog";
import { exists, mkdir, readDir, readFile, remove, writeFile } from "@tauri-apps/plugin-fs";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import type {
  AppLog,
  BackupEstado,
  BackupFrecuencia,
  BackupRecord,
  BackupSettings,
  BackupTipo,
  ConnectedUser,
  EstadoRequisicion,
  Folio,
  ImageBlob,
  LogLevel,
  PlacasExistentes,
  Permiso,
  PlasticItem,
  PlasticPiece,
  PlasticProduct,
  PlasticProductInput,
  Precio,
  PrecioInput,
  PrecioVenta,
  PrecioVentaEntradaInput,
  PrintItem,
  PrintItemCheck,
  PrintItemExtra,
  PrintItemImage,
  PrintItemOrder,
  PrintItemPurchase,
  Product,
  ProductDescription,
  ProductInput,
  ProductSpec,
  Remision,
  RemisionConRenglones,
  RemisionHistorialRow,
  RemisionInput,
  RemisionRenglon,
  RemisionRenglonInput,
  Requisicion,
  RequisicionInput,
  Rol,
  SearchFilter,
  TipoFolio,
  TipoRemision,
  User,
  UserInput,
  WoodItem,
  WoodProduct,
  WoodProductInput,
} from "./types";
import { PROCESOS_IMPRENTA, PRECIOS_VENTA_CATEGORIAS, TIPOS_PRODUCTO } from "./types";
import { buildRequisicionMessage } from "./requisiciones";
import { FOLIO_PREFIJOS, buildFolioString, fechaLocalDeHoy, formatFechaFolioLocal } from "./folios";
import { computeSkuPrincipal } from "./precios";
import { numeroATextoMoneda } from "./numeroALetras";
import {
  type DumpIndex,
  type DumpTable,
  backupFileName,
  buildBackupSql,
  extractRestoreStatements,
  validateRestoreStatements,
} from "./backup";
import { buildBackupArchive } from "./backupWorkerClient";

const client = createClient({
  url: import.meta.env.VITE_TURSO_URL,
  authToken: import.meta.env.VITE_TURSO_AUTH_TOKEN,
  intMode: "number",
});

// Firma común entre Client y Transaction — funciones de un solo statement
// que también se llaman desde dentro de una transacción más grande (p.ej.
// createPlasticProduct/updatePlasticProduct desde savePlasticItems) aceptan
// esto en vez de asumir siempre el client de módulo, para poder correr sobre
// el mismo tx del llamador y quedar cubiertas por su commit/rollback.
type Executor = Pick<Transaction, "execute">;

function toImageBlob(data: unknown, mime: unknown): ImageBlob | null {
  if (!(data instanceof ArrayBuffer) || typeof mime !== "string") return null;
  return { data: new Uint8Array(data), mime };
}

interface ProductRow {
  id: number;
  codigo: string;
  nombre: string;
  categoria: string;
  material: string;
  descripcion: string;
  imagen: ArrayBuffer | null;
  imagen_mime: string | null;
  imagen_codigo_barras: ArrayBuffer | null;
  imagen_codigo_barras_mime: string | null;
  tipo_producto: string | null;
  codigo_barras_texto: string | null;
  presentacion_original: string | null;
  creado_en: string;
  actualizado_en: string | null;
}

function rowToProduct(row: ProductRow): Product {
  return {
    id: row.id,
    codigo: row.codigo,
    nombre: row.nombre,
    categoria: row.categoria,
    material: row.material,
    descripcion: row.descripcion,
    imagen: toImageBlob(row.imagen, row.imagen_mime),
    imagen_codigo_barras: toImageBlob(row.imagen_codigo_barras, row.imagen_codigo_barras_mime),
    tipo_producto: row.tipo_producto ?? "",
    codigo_barras_texto: row.codigo_barras_texto ?? "",
    presentacion_original: row.presentacion_original ?? "",
    creado_en: row.creado_en,
    actualizado_en: row.actualizado_en ?? row.creado_en,
  };
}

// TIPOS_PRODUCTO es un valor controlado (ver types.ts) — el selector en
// ProductForm ya restringe la UI, pero createProduct/updateProduct son la
// puerta real de escritura, así que validan también aquí: nunca confiar en
// que el llamador (front, o alguien llamando estas funciones a mano desde
// devtools) mande un valor fuera de la lista.
function assertTipoProductoValido(tipoProducto: string): void {
  if (tipoProducto && !(TIPOS_PRODUCTO as readonly string[]).includes(tipoProducto)) {
    throw new Error(`Tipo de producto inválido: "${tipoProducto}".`);
  }
}

// Búsqueda insensible a mayúsculas/minúsculas y a acentos: SQLite folda
// mayúsculas solo en ASCII, así que "México"/"MEXICO" no calzan por sí solos.
// `foldSearchColumn` envuelve la columna en `replace()` por cada vocal/ñ/ü
// acentuada antes de aplicar `lower()`, y `normalizeSearchTerm` (mismo
// criterio NFD que `normalizeHeader` en fichaImport.ts/precios.ts) hace lo
// mismo del lado del término buscado, para que ambos lados queden en la
// misma forma "plana" antes del LIKE.
const FOLDABLE_CHARS: [string, string][] = [
  ["á", "a"], ["Á", "a"],
  ["é", "e"], ["É", "e"],
  ["í", "i"], ["Í", "i"],
  ["ó", "o"], ["Ó", "o"],
  ["ú", "u"], ["Ú", "u"],
  ["ü", "u"], ["Ü", "u"],
  ["ñ", "n"], ["Ñ", "n"],
];

function foldSearchColumn(column: string): string {
  const replaced = FOLDABLE_CHARS.reduce(
    (expr, [from, to]) => `replace(${expr}, '${from}', '${to}')`,
    column,
  );
  return `lower(${replaced})`;
}

function normalizeSearchTerm(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const SEARCH_FILTER_CLAUSES: Record<SearchFilter, string> = {
  todo: `${foldSearchColumn("codigo")} LIKE ?1 OR ${foldSearchColumn("nombre")} LIKE ?1 OR ${foldSearchColumn("material")} LIKE ?1`,
  nombre: `${foldSearchColumn("nombre")} LIKE ?1 OR ${foldSearchColumn("descripcion")} LIKE ?1`,
  sku: `${foldSearchColumn("codigo")} LIKE ?1`,
  material: `${foldSearchColumn("material")} LIKE ?1`,
};

// Sin las columnas de imagen (BLOB) — listar/buscar no las necesita y, con
// más de 1300 fichas, traerlas todas en cada búsqueda o carga de pantalla
// vuelve la app perceptiblemente lenta. `rowToProduct` ya maneja columnas de
// imagen ausentes como `null` (ver `toImageBlob`), así que el resultado sigue
// siendo un `Product` válido, solo que sin imagen cargada — quien la necesite
// la pide aparte con `getProductImage` (usado por `ProductCard`); `getProduct`
// (ficha completa) sigue trayendo todo con `SELECT *`.
const PRODUCT_LIST_COLUMNS =
  "id, codigo, nombre, categoria, material, descripcion, presentacion_original, creado_en, actualizado_en";

export async function searchProducts(
  query: string,
  filter: SearchFilter = "todo",
): Promise<Product[]> {
  const trimmed = query.trim();
  const result = trimmed
    ? await client.execute({
        sql: `SELECT ${PRODUCT_LIST_COLUMNS} FROM products WHERE ${SEARCH_FILTER_CLAUSES[filter]} ORDER BY nombre, material`,
        args: [`%${normalizeSearchTerm(trimmed)}%`],
      })
    : await client.execute(
        `SELECT ${PRODUCT_LIST_COLUMNS} FROM products ORDER BY nombre, material`,
      );
  return (result.rows as unknown as ProductRow[]).map(rowToProduct);
}

export async function getProduct(id: number): Promise<Product | null> {
  const result = await client.execute({
    sql: "SELECT * FROM products WHERE id = ?1",
    args: [id],
  });
  const row = result.rows[0] as unknown as ProductRow | undefined;
  return row ? rowToProduct(row) : null;
}

// Imagen de portada de una ficha por separado de `searchProducts` (que ya no
// la trae, ver PRODUCT_LIST_COLUMNS) — usada por `ProductCard` para cargar
// solo la imagen de las fichas realmente visibles en pantalla, no las de
// todo el catálogo.
export async function getProductImage(id: number): Promise<ImageBlob | null> {
  const result = await client.execute({
    sql: "SELECT imagen, imagen_mime FROM products WHERE id = ?1",
    args: [id],
  });
  const row = result.rows[0] as unknown as { imagen: ArrayBuffer | null; imagen_mime: string | null } | undefined;
  return row ? toImageBlob(row.imagen, row.imagen_mime) : null;
}

interface ProductSpecRow {
  id: number;
  product_id: number;
  etiqueta: string;
  valor: string;
  orden: number;
  permite_requisicion: number;
}

function rowToProductSpec(row: ProductSpecRow): ProductSpec {
  return { ...row, permite_requisicion: Boolean(row.permite_requisicion) };
}

export async function getProductSpecs(
  productId: number,
): Promise<ProductSpec[]> {
  const result = await client.execute({
    sql: "SELECT * FROM product_specs WHERE product_id = ?1 ORDER BY orden, id",
    args: [productId],
  });
  return (result.rows as unknown as ProductSpecRow[]).map(rowToProductSpec);
}

export async function createProduct(
  actor: Actor,
  product: ProductInput,
  specs: ProductSpec[],
  descriptions: ProductDescription[] = [],
): Promise<number> {
  await assertActorSession(actor);
  assertTipoProductoValido(product.tipo_producto);
  // Header + specs + descriptions en una sola transacción interactiva: antes
  // eran client.execute() sueltos, así que una falla a medias (ej. conexión
  // caída justo después del INSERT del producto) dejaba una ficha sin sus
  // specs — sobre todo relevante en Captura masiva, donde esto corre fila
  // tras fila sin supervisión.
  const tx = await client.transaction("write");
  try {
    const result = await tx.execute({
      sql: `INSERT INTO products (codigo, nombre, categoria, material, descripcion, imagen, imagen_mime, imagen_codigo_barras, imagen_codigo_barras_mime, tipo_producto, codigo_barras_texto, actualizado_en)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'))`,
      args: [
        product.codigo,
        product.nombre,
        product.categoria,
        product.material,
        product.descripcion,
        product.imagen?.data ?? null,
        product.imagen?.mime ?? null,
        product.imagen_codigo_barras?.data ?? null,
        product.imagen_codigo_barras?.mime ?? null,
        product.tipo_producto || null,
        product.codigo_barras_texto || null,
      ],
    });
    const productId = Number(result.lastInsertRowid);
    await insertSpecs(tx, productId, specs);
    await insertDescriptions(tx, productId, descriptions);
    // Si la captura masiva de imágenes guardó antes una imagen para este
    // código (porque en ese momento no existía la ficha), se aplica sola
    // aquí, dentro de la misma transacción — solo cuando la ficha se crea
    // sin imagen propia, para no pisar una que el usuario ya haya elegido
    // en este mismo alta.
    await applyPendingProductImage(tx, productId, product.codigo);
    await tx.commit();
    return productId;
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}

export async function updateProduct(
  actor: Actor,
  id: number,
  product: ProductInput,
  specs: ProductSpec[],
  descriptions: ProductDescription[] = [],
): Promise<void> {
  await assertActorSession(actor);
  assertTipoProductoValido(product.tipo_producto);
  const tx = await client.transaction("write");
  try {
    await tx.execute({
      sql: `UPDATE products
            SET codigo = ?1, nombre = ?2, categoria = ?3, material = ?4, descripcion = ?5, imagen = ?6, imagen_mime = ?7,
                imagen_codigo_barras = ?8, imagen_codigo_barras_mime = ?9,
                tipo_producto = ?10, codigo_barras_texto = ?11,
                actualizado_en = datetime('now')
            WHERE id = ?12`,
      args: [
        product.codigo,
        product.nombre,
        product.categoria,
        product.material,
        product.descripcion,
        product.imagen?.data ?? null,
        product.imagen?.mime ?? null,
        product.imagen_codigo_barras?.data ?? null,
        product.imagen_codigo_barras?.mime ?? null,
        product.tipo_producto || null,
        product.codigo_barras_texto || null,
        id,
      ],
    });
    await tx.execute({
      sql: "DELETE FROM product_specs WHERE product_id = ?1",
      args: [id],
    });
    await insertSpecs(tx, id, specs);
    await tx.execute({
      sql: "DELETE FROM product_descriptions WHERE product_id = ?1",
      args: [id],
    });
    await insertDescriptions(tx, id, descriptions);
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}

async function insertSpecs(
  tx: Transaction,
  productId: number,
  specs: ProductSpec[],
): Promise<void> {
  let orden = 1;
  for (const spec of specs) {
    const etiqueta = spec.etiqueta.trim();
    const valor = spec.valor.trim();
    if (!etiqueta || !valor) continue;
    await tx.execute({
      sql: `INSERT INTO product_specs (product_id, etiqueta, valor, orden, permite_requisicion) VALUES (?1, ?2, ?3, ?4, ?5)`,
      args: [productId, etiqueta, valor, orden, spec.permite_requisicion ? 1 : 0],
    });
    orden += 1;
  }
}

interface ProductDescriptionRow {
  id: number;
  product_id: number;
  etiqueta: string;
  texto: string;
  orden: number;
}

export async function getProductDescriptions(
  productId: number,
): Promise<ProductDescription[]> {
  const result = await client.execute({
    sql: "SELECT * FROM product_descriptions WHERE product_id = ?1 ORDER BY orden, id",
    args: [productId],
  });
  return result.rows as unknown as ProductDescriptionRow[];
}

async function insertDescriptions(
  tx: Transaction,
  productId: number,
  descriptions: ProductDescription[],
): Promise<void> {
  let orden = 1;
  for (const description of descriptions) {
    const etiqueta = description.etiqueta.trim();
    const texto = description.texto.trim();
    if (!etiqueta || !texto) continue;
    await tx.execute({
      sql: `INSERT INTO product_descriptions (product_id, etiqueta, texto, orden) VALUES (?1, ?2, ?3, ?4)`,
      args: [productId, etiqueta, texto, orden],
    });
    orden += 1;
  }
}

export async function deleteProduct(actor: Actor, id: number): Promise<void> {
  await assertActorSession(actor);
  const tx = await client.transaction("write");
  try {
    await tx.execute({
      sql: "DELETE FROM product_specs WHERE product_id = ?1",
      args: [id],
    });
    await tx.execute({
      sql: "DELETE FROM product_descriptions WHERE product_id = ?1",
      args: [id],
    });
    await tx.execute({
      sql: "DELETE FROM product_plastic_pieces WHERE product_id = ?1",
      args: [id],
    });
    // Vínculos con el catálogo maestro de Piezas — faltaba, dejaba filas
    // huérfanas en product_plastic_items apuntando a un product_id borrado
    // (detectado por la prueba de integridad de eliminaciones). No borra
    // las piezas en sí (plastic_products), solo el vínculo de esta ficha.
    await tx.execute({
      sql: "DELETE FROM product_plastic_items WHERE product_id = ?1",
      args: [id],
    });
    // Mismo criterio que product_plastic_items justo arriba — vínculos con
    // el catálogo maestro de Maderas. No borra los productos de madera en
    // sí (wood_products), solo el vínculo de esta ficha.
    await tx.execute({
      sql: "DELETE FROM product_wood_items WHERE product_id = ?1",
      args: [id],
    });
    const items = await tx.execute({
      sql: "SELECT id FROM product_print_items WHERE product_id = ?1",
      args: [id],
    });
    for (const row of items.rows as unknown as { id: number }[]) {
      await tx.execute({
        sql: "DELETE FROM product_print_item_checks WHERE print_item_id = ?1",
        args: [row.id],
      });
      await tx.execute({
        sql: "DELETE FROM product_print_item_extras WHERE print_item_id = ?1",
        args: [row.id],
      });
      await tx.execute({
        sql: "DELETE FROM product_print_item_images WHERE print_item_id = ?1",
        args: [row.id],
      });
      await tx.execute({
        sql: `DELETE FROM product_print_item_purchases WHERE print_item_order_id IN
              (SELECT id FROM product_print_item_orders WHERE print_item_id = ?1)`,
        args: [row.id],
      });
      await tx.execute({
        sql: "DELETE FROM product_print_item_orders WHERE print_item_id = ?1",
        args: [row.id],
      });
    }
    await tx.execute({
      sql: "DELETE FROM product_print_items WHERE product_id = ?1",
      args: [id],
    });
    await tx.execute({ sql: "DELETE FROM products WHERE id = ?1", args: [id] });
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}

export async function findProductByCodigo(codigo: string): Promise<Product | null> {
  const result = await client.execute({
    sql: "SELECT * FROM products WHERE codigo = ?1",
    args: [codigo.trim()],
  });
  const row = result.rows[0] as unknown as ProductRow | undefined;
  return row ? rowToProduct(row) : null;
}

export async function findProductsByNombre(nombre: string): Promise<Product[]> {
  const result = await client.execute({
    sql: "SELECT * FROM products WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?1))",
    args: [nombre],
  });
  return (result.rows as unknown as ProductRow[]).map(rowToProduct);
}

// Solo la usa FichaImportPanel (captura masiva, exclusiva de admin — ver
// docs/PERMISSIONS.md), de ahí que exija Actor admin sin permiso otorgable.
export async function setPresentacionOriginal(actor: Actor, productId: number, text: string): Promise<void> {
  await assertActorAuthorized(actor);
  await client.execute({
    sql: "UPDATE products SET presentacion_original = ?1 WHERE id = ?2",
    args: [text, productId],
  });
}

export async function codigoEnUso(
  codigo: string,
  excludeId?: number,
): Promise<boolean> {
  const result = await client.execute({
    sql: "SELECT id FROM products WHERE codigo = ?1",
    args: [codigo.trim()],
  });
  return (result.rows as unknown as { id: number }[]).some(
    (row) => row.id !== excludeId,
  );
}

export const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export async function getImageSrc(
  imagen: ImageBlob | null,
): Promise<string | null> {
  if (!imagen) return null;
  return URL.createObjectURL(new Blob([imagen.data], { type: imagen.mime }));
}

// --- Validación de archivos importados (no confiar solo en la extensión) ---

export const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024;
// 25MB alcanzaba para los Excel de solo texto (fichas/precios); la
// importación de piezas admite imágenes embebidas dentro del propio .xlsx,
// que pueden pesar varios cientos de KB cada una — se sube el tope con
// margen amplio, compartido por los tres flujos de importación.
export const MAX_EXCEL_IMPORT_FILE_BYTES = 200 * 1024 * 1024;

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Firma real de los bytes (magic numbers), no la extensión del nombre de
// archivo — un .jpg renombrado desde cualquier otra cosa no debe colarse.
function detectImageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function validateImageBlob(data: Uint8Array): ImageBlob {
  if (data.length === 0) throw new Error("El archivo de imagen está vacío.");
  if (data.length > MAX_IMAGE_FILE_BYTES) {
    throw new Error(
      `La imagen pesa ${formatMB(data.length)}, mayor al límite permitido (${formatMB(MAX_IMAGE_FILE_BYTES)}).`,
    );
  }
  const mime = detectImageMime(data);
  if (!mime) {
    throw new Error(
      "El archivo no es una imagen válida (png/jpg/webp/gif) — el contenido no coincide con ningún formato soportado.",
    );
  }
  return { data, mime };
}

// Wrapper público de validateImageBlob — usado por la importación masiva de
// piezas para validar imágenes descargadas sin duplicar la lógica de firma
// real de bytes (detectImageMime es privada a este módulo).
export function validateImportedImageBytes(data: Uint8Array): ImageBlob {
  return validateImageBlob(data);
}

// Descarga la imagen de un link del Excel de Piezas (columna "Links Imágenes
// Piezas", típicamente Google Drive/Photos). Usa @tauri-apps/plugin-http en
// vez de fetch() del navegador porque la petición corre en el proceso Rust,
// fuera del alcance del CSP connect-src del webview (que solo permite
// Turso) — el dominio de destino igual queda acotado por el scope de
// capabilities/default.json (http:default), no por esto.
//
// User-Agent explícito: Google devuelve 403 en algunos endpoints de Drive
// cuando la petición no trae uno reconocible (el cliente HTTP de Tauri, sin
// esto, manda su propio user-agent genérico).
export async function downloadImportedImage(url: string): Promise<ImageBlob> {
  let response: Response;
  try {
    response = await tauriFetch(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
  } catch (err) {
    throw new Error(`No se pudo descargar la imagen: ${String(err)}`);
  }
  if (!response.ok) {
    throw new Error(`La descarga de la imagen falló (HTTP ${response.status}).`);
  }
  const buffer = await response.arrayBuffer();
  return validateImageBlob(new Uint8Array(buffer));
}

// Prueba varias URLs candidatas para la misma imagen en orden hasta que una
// funcione (ver buildImageLinkCandidates en piezasImport.ts) — necesario
// porque drive.google.com/uc?export=download devuelve 403 con cierta
// frecuencia para peticiones no interactivas, incluso con el archivo
// compartido públicamente; el endpoint de miniatura es más confiable para
// imágenes y se intenta primero.
export async function downloadImportedImageFromCandidates(urls: string[]): Promise<ImageBlob> {
  const errors: string[] = [];
  for (const url of urls) {
    try {
      return await downloadImportedImage(url);
    } catch (err) {
      errors.push(String(err));
    }
  }
  throw new Error(
    `No se pudo descargar la imagen desde ninguna variante del link (${errors.length} intento(s)): ${errors.join(" | ")}`,
  );
}

// xlsx es un contenedor ZIP — firma "PK" con cualquiera de los subtipos
// válidos de cabecera local ZIP (03 04 normal, 05 06 archivo vacío, 07 08
// spanned). Un .csv/.xls/etc. renombrado a .xlsx no pasa esta firma.
function looksLikeXlsx(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  return (
    bytes[0] === 0x50 && bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)
  );
}

// El scope de fs de la app es angosto a propósito (solo appData — ver
// capabilities/default.json): un path elegido por el usuario en un diálogo
// nativo (open/save) no entra automáticamente al scope de Tauri, así que
// justo después de cada diálogo hay que extenderlo en runtime para ese path
// puntual antes de leer/escribir ahí. El comando Rust valida además que sea
// absoluto y sin segmentos "..".
export async function allowFsPath(path: string, isDir = false): Promise<void> {
  await invoke("allow_fs_path", { path, isDir });
}

export async function pickImage(): Promise<ImageBlob | null> {
  const selected = await open({
    multiple: false,
    filters: [
      { name: "Imágenes", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
    ],
  });
  if (!selected || Array.isArray(selected)) return null;
  const ext = selected.split(".").pop()?.toLowerCase() ?? "";
  if (!Object.prototype.hasOwnProperty.call(MIME_BY_EXT, ext)) {
    throw new Error(`Extensión de archivo no soportada (.${ext || "?"}).`);
  }
  await allowFsPath(selected);
  const data = await readFile(selected);
  return validateImageBlob(data);
}

export async function pickExcelFile(): Promise<Uint8Array | null> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "Excel", extensions: ["xlsx"] }],
  });
  if (!selected || Array.isArray(selected)) return null;
  if (!selected.toLowerCase().endsWith(".xlsx")) {
    throw new Error("El archivo debe tener extensión .xlsx.");
  }
  await allowFsPath(selected);
  const data = await readFile(selected);
  if (data.length === 0) {
    throw new Error("El archivo está vacío.");
  }
  if (data.length > MAX_EXCEL_IMPORT_FILE_BYTES) {
    throw new Error(
      `El archivo pesa ${formatMB(data.length)}, mayor al límite permitido (${formatMB(MAX_EXCEL_IMPORT_FILE_BYTES)}).`,
    );
  }
  if (!looksLikeXlsx(data)) {
    throw new Error(
      "El archivo no es un Excel (.xlsx) válido — el contenido no coincide con el formato esperado.",
    );
  }
  return data;
}

export interface ImageFolderEntry {
  name: string;
  path: string;
}

export async function pickImageFolder(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  if (!selected || Array.isArray(selected)) return null;
  // No recursivo: listImageFolderFiles solo lee el nivel superior.
  await allowFsPath(selected, true);
  return selected;
}

// macOS crea un archivo "._nombre.ext" (AppleDouble, guarda metadata
// extendida/resource fork) por cada archivo real al copiar a una unidad no
// HFS+ (USB, red, exFAT/FAT32) — no es una imagen, aunque comparta
// extensión con una real. ".DS_Store" es el mismo tipo de basura de Finder,
// una por carpeta. Ninguno de los dos debe llegar a classifyImageEntries.
function isMacOsMetadataFile(name: string): boolean {
  return name.startsWith("._") || name === ".DS_Store";
}

export async function listImageFolderFiles(
  folderPath: string,
): Promise<ImageFolderEntry[]> {
  const entries = await readDir(folderPath);
  const files: ImageFolderEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile) continue;
    if (isMacOsMetadataFile(entry.name)) continue;
    files.push({ name: entry.name, path: await join(folderPath, entry.name) });
  }
  return files;
}

export async function readImageFileBlob(path: string): Promise<ImageBlob> {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (!Object.prototype.hasOwnProperty.call(MIME_BY_EXT, ext)) {
    throw new Error(`Extensión de archivo no soportada (.${ext || "?"}).`);
  }
  const data = await readFile(path);
  return validateImageBlob(data);
}

// Solo la usa ImageImportPanel (captura masiva, exclusiva de admin — ver
// docs/PERMISSIONS.md), de ahí que exija Actor admin sin permiso otorgable.
export async function updateProductImage(
  actor: Actor,
  id: number,
  imagen: ImageBlob,
): Promise<void> {
  await assertActorAuthorized(actor);
  await client.execute({
    sql: "UPDATE products SET imagen = ?1, imagen_mime = ?2 WHERE id = ?3",
    args: [imagen.data, imagen.mime, id],
  });
}

// --- Imágenes pendientes (captura masiva de imágenes sobre un código que
// todavía no tiene ficha técnica) ---

// Se llama dentro de la transacción de createProduct — si existe una imagen
// guardada para este código, se aplica y se borra de "pendientes". No pisa
// una imagen que la propia alta ya haya traído (createProduct manual con
// imagen elegida a mano, o una futura importación de fichas con imagen
// inline).
async function applyPendingProductImage(
  execer: Client | Transaction,
  productId: number,
  codigo: string,
): Promise<void> {
  const result = await execer.execute({
    sql: "SELECT id, imagen, imagen_mime FROM pending_product_images WHERE codigo = ?1",
    args: [codigo],
  });
  const row = result.rows[0] as unknown as
    | { id: number; imagen: ArrayBuffer; imagen_mime: string }
    | undefined;
  if (!row) return;
  await execer.execute({
    sql: "UPDATE products SET imagen = ?1, imagen_mime = ?2 WHERE id = ?3 AND imagen IS NULL",
    args: [row.imagen, row.imagen_mime, productId],
  });
  await execer.execute({ sql: "DELETE FROM pending_product_images WHERE id = ?1", args: [row.id] });
}

// Usada por la captura masiva de imágenes (isAdmin) cuando el código del
// archivo no corresponde a ninguna ficha técnica todavía — la imagen queda
// guardada aquí en vez de descartarse, lista para aplicarse sola si más
// adelante se crea un producto con ese código (ver applyPendingProductImage
// arriba). ON CONFLICT(codigo) por si el mismo código se reimporta sin
// ficha dos veces — la imagen más reciente reemplaza a la anterior, no se
// acumulan filas por el mismo código.
export async function upsertPendingProductImage(
  actor: Actor,
  input: { codigo: string; imagen: ImageBlob; archivoOriginal: string; usuario: string | null },
): Promise<void> {
  await assertActorAuthorized(actor);
  await client.execute({
    sql: `INSERT INTO pending_product_images (codigo, imagen, imagen_mime, archivo_original, creado_por)
          VALUES (?1, ?2, ?3, ?4, ?5)
          ON CONFLICT(codigo) DO UPDATE SET
            imagen = ?2, imagen_mime = ?3, archivo_original = ?4, creado_por = ?5, creado_en = datetime('now')`,
    args: [input.codigo, input.imagen.data, input.imagen.mime, input.archivoOriginal, input.usuario],
  });
}

// --- Usuarios y permisos ---

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  activo: number;
  rol: string;
  creado_en: string;
}

async function rowToUser(row: UserRow): Promise<User> {
  const permsResult = await client.execute({
    sql: "SELECT permiso FROM user_permissions WHERE user_id = ?1",
    args: [row.id],
  });
  const permisos = (permsResult.rows as unknown as { permiso: string }[]).map(
    (r) => r.permiso as Permiso,
  );
  return {
    id: row.id,
    username: row.username,
    activo: Boolean(row.activo),
    rol: row.rol as Rol,
    permisos,
    creado_en: row.creado_en,
  };
}

const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MINUTES = 15;
// Sesión deslizante: cada login o validateSession() exitoso extiende el
// vencimiento este tanto hacia adelante — una sesión en uso activo (la app
// revalida periódicamente, ver auth.tsx) nunca expira a medias, pero un
// token abandonado (localStorage de una máquina apagada, o robado sin más
// actividad) deja de servir pasadas estas horas sin necesitar cambio de
// contraseña ni logout explícito.
const SESSION_TTL_HOURS = 12;

interface LoginRow extends UserRow {
  failed_attempts: number;
  is_locked: number;
}

export type LoginResult =
  | { status: "ok"; user: User; token: string }
  | { status: "invalid" }
  | { status: "locked" };

function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyLogin(
  username: string,
  password: string,
): Promise<LoginResult> {
  const result = await client.execute({
    sql: `SELECT *, (locked_until IS NOT NULL AND locked_until > datetime('now')) AS is_locked
          FROM users WHERE username = ?1`,
    args: [username.trim()],
  });
  const row = result.rows[0] as unknown as LoginRow | undefined;
  if (!row || !row.activo) return { status: "invalid" };
  if (row.is_locked) return { status: "locked" };

  const ok = await invoke<boolean>("verify_password", {
    password,
    hash: row.password_hash,
  });

  if (!ok) {
    const attempts = (row.failed_attempts ?? 0) + 1;
    if (attempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
      await client.execute({
        sql: `UPDATE users SET failed_attempts = ?1, locked_until = datetime('now', ?2) WHERE id = ?3`,
        args: [attempts, `+${LOGIN_LOCKOUT_MINUTES} minutes`, row.id],
      });
    } else {
      await client.execute({
        sql: "UPDATE users SET failed_attempts = ?1 WHERE id = ?2",
        args: [attempts, row.id],
      });
    }
    return { status: "invalid" };
  }

  const token = generateSessionToken();
  await client.execute({
    sql: `UPDATE users
          SET failed_attempts = 0, locked_until = NULL, session_token = ?1,
              session_expires_at = datetime('now', ?2)
          WHERE id = ?3`,
    args: [token, `+${SESSION_TTL_HOURS} hours`, row.id],
  });
  return { status: "ok", user: await rowToUser(row), token };
}

export async function validateSession(id: number, token: string): Promise<User | null> {
  const result = await client.execute({
    sql: `SELECT * FROM users
          WHERE id = ?1 AND session_token = ?2
            AND session_expires_at IS NOT NULL AND session_expires_at > datetime('now')`,
    args: [id, token],
  });
  const row = result.rows[0] as unknown as UserRow | undefined;
  if (!row || !row.activo) return null;
  await client.execute({
    sql: "UPDATE users SET session_expires_at = datetime('now', ?1) WHERE id = ?2",
    args: [`+${SESSION_TTL_HOURS} hours`, id],
  });
  return rowToUser(row);
}

export interface Actor {
  id: number;
  token: string;
}

// Defensa en profundidad para operaciones sensibles (catálogo, precios,
// remisiones, producción, restaurar/eliminar backups, cambiar su
// programación, administrar usuarios y permisos): la app no tiene backend
// propio (ver docs/ARCHITECTURE.md — el token de Turso vive en el bundle por
// diseño, es un constraint aceptado, no un descuido), así que esto NO es una
// barrera real contra alguien con ese token embebido y acceso a
// devtools/consola. Lo que sí evita es que un botón mal gateado, un bug de
// UI, o un uso "creativo" de las funciones exportadas de este archivo
// ejecute la operación sin pasar por una sesión real, vigente y con el rol o
// permiso correcto verificados contra la BD — no solo un booleano que el
// propio llamador podría fabricar.
async function loadActorSession(
  actor: Actor,
): Promise<{ username: string; rol: string; activo: number } | undefined> {
  const result = await client.execute({
    sql: `SELECT username, rol, activo FROM users
          WHERE id = ?1 AND session_token = ?2
            AND session_expires_at IS NOT NULL AND session_expires_at > datetime('now')`,
    args: [actor.id, actor.token],
  });
  return result.rows[0] as unknown as { username: string; rol: string; activo: number } | undefined;
}

// Para acciones que no tienen un permiso otorgable propio (ej. catálogo
// base, intencionalmente abierto a cualquier usuario autenticado — ver
// docs/PERMISSIONS.md): solo exige una sesión vigente y activa, sin rol ni
// permiso específico. Devuelve el username verificado contra la BD (no el
// que mande el llamador) para que las columnas de auditoría (usuario,
// actualizado_por, etc.) se deriven del Actor real, no de un string aparte.
async function assertActorSession(actor: Actor): Promise<string> {
  const row = await loadActorSession(actor);
  if (!row || !row.activo) {
    throw new Error("No autorizado: la sesión no es válida o venció.");
  }
  return row.username;
}

async function assertActorAuthorized(
  actor: Actor,
  requiredPermiso?: Permiso | Permiso[],
): Promise<string> {
  const row = await loadActorSession(actor);
  if (!row || !row.activo) {
    throw new Error("No autorizado: la sesión no es válida o venció.");
  }
  if (row.rol === "admin") return row.username;
  if (!requiredPermiso) {
    throw new Error("No autorizado: esta acción requiere una cuenta administradora.");
  }
  const permisos = Array.isArray(requiredPermiso) ? requiredPermiso : [requiredPermiso];
  const placeholders = permisos.map((_, i) => `?${i + 2}`).join(", ");
  const permResult = await client.execute({
    sql: `SELECT 1 FROM user_permissions WHERE user_id = ?1 AND permiso IN (${placeholders})`,
    args: [actor.id, ...permisos],
  });
  if (permResult.rows.length === 0) {
    throw new Error("No autorizado: falta el permiso requerido para esta acción.");
  }
  return row.username;
}

export async function listUsers(): Promise<User[]> {
  const result = await client.execute("SELECT * FROM users ORDER BY username");
  return Promise.all((result.rows as unknown as UserRow[]).map(rowToUser));
}

export async function usernameEnUso(
  username: string,
  excludeId?: number,
): Promise<boolean> {
  const result = await client.execute({
    sql: "SELECT id FROM users WHERE username = ?1",
    args: [username.trim()],
  });
  return (result.rows as unknown as { id: number }[]).some(
    (row) => row.id !== excludeId,
  );
}

export async function createUser(actor: Actor, input: UserInput): Promise<number> {
  await assertActorAuthorized(actor);
  if (!input.password) throw new Error("La contraseña es obligatoria.");
  const hash = await invoke<string>("hash_password", { password: input.password });

  const tx = await client.transaction("write");
  try {
    const result = await tx.execute({
      sql: `INSERT INTO users (username, password_hash, activo, rol) VALUES (?1, ?2, ?3, ?4)`,
      args: [input.username.trim(), hash, input.activo ? 1 : 0, input.rol],
    });
    const userId = Number(result.lastInsertRowid);
    await savePermissions(userId, input.permisos, tx);
    await tx.commit();
    return userId;
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}

export async function updateUser(actor: Actor, id: number, input: UserInput): Promise<void> {
  await assertActorAuthorized(actor);
  const hash = input.password ? await invoke<string>("hash_password", { password: input.password }) : null;
  const willBeActiveAdmin = input.rol === "admin" && !!input.activo;

  const tx = await client.transaction("write");
  try {
    // Protección del último admin activo, verificada en el servidor (no solo
    // en UsersPanel, que puede operar sobre un array de usuarios ya
    // desactualizado en memoria): si este cambio hace que el usuario deje de
    // ser admin-activo, exige que quede al menos otro admin-activo, contado
    // dentro de esta misma transacción para que no haya ventana de carrera
    // con otra edición concurrente.
    if (!willBeActiveAdmin) {
      const current = await tx.execute({ sql: "SELECT rol, activo FROM users WHERE id = ?1", args: [id] });
      const row = current.rows[0] as unknown as { rol: string; activo: number } | undefined;
      const wasActiveAdmin = !!row && row.rol === "admin" && !!row.activo;
      if (wasActiveAdmin) {
        const others = await tx.execute({
          sql: "SELECT 1 FROM users WHERE id != ?1 AND rol = 'admin' AND activo = 1 LIMIT 1",
          args: [id],
        });
        if (others.rows.length === 0) {
          throw new Error("Debe existir al menos un administrador activo.");
        }
      }
    }

    if (hash) {
      await tx.execute({
        sql: `UPDATE users SET username = ?1, activo = ?2, rol = ?3, password_hash = ?4, session_token = NULL, session_expires_at = NULL WHERE id = ?5`,
        args: [input.username.trim(), input.activo ? 1 : 0, input.rol, hash, id],
      });
    } else {
      await tx.execute({
        sql: `UPDATE users SET username = ?1, activo = ?2, rol = ?3 WHERE id = ?4`,
        args: [input.username.trim(), input.activo ? 1 : 0, input.rol, id],
      });
    }
    await savePermissions(id, input.permisos, tx);
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}

async function savePermissions(userId: number, permisos: Permiso[], executor: Executor = client): Promise<void> {
  await executor.execute({
    sql: "DELETE FROM user_permissions WHERE user_id = ?1",
    args: [userId],
  });
  for (const permiso of permisos) {
    await executor.execute({
      sql: "INSERT INTO user_permissions (user_id, permiso) VALUES (?1, ?2)",
      args: [userId, permiso],
    });
  }
}

// --- Sesiones (usuarios conectados) ---

const SESSION_STALE_SECONDS = 90;

export async function heartbeat(userId: number): Promise<void> {
  await client.execute({
    sql: `INSERT INTO user_sessions (user_id, last_seen) VALUES (?1, datetime('now'))
          ON CONFLICT(user_id) DO UPDATE SET last_seen = datetime('now')`,
    args: [userId],
  });
  await client.execute({
    sql: `DELETE FROM user_sessions WHERE last_seen < datetime('now', ?1)`,
    args: [`-${SESSION_STALE_SECONDS} seconds`],
  });
}

// token identifica LA sesión que se está cerrando, no solo el usuario: sin
// esto, un logout con un token ya viejo (p.ej. una pestaña que quedó atrás)
// podía pisar session_token de una sesión más nueva del mismo usuario abierta
// después en otro dispositivo, cerrándola sin que esa persona hiciera nada.
// Mismo criterio que ya usan validateSession()/loadActorSession() (id AND
// session_token). La fila de presencia en user_sessions sigue limpiándose
// solo por user_id — no es sensible, es la tabla de "¿tiene la app abierta?".
export async function clearSession(userId: number, token: string): Promise<void> {
  await client.execute({
    sql: "DELETE FROM user_sessions WHERE user_id = ?1",
    args: [userId],
  });
  await client.execute({
    sql: "UPDATE users SET session_token = NULL, session_expires_at = NULL WHERE id = ?1 AND session_token = ?2",
    args: [userId, token],
  });
}

export async function getConnectedUsers(): Promise<ConnectedUser[]> {
  const result = await client.execute({
    sql: `SELECT u.id, u.username, s.last_seen FROM user_sessions s
          JOIN users u ON u.id = s.user_id
          WHERE s.last_seen >= datetime('now', ?1)
          ORDER BY u.username`,
    args: [`-${SESSION_STALE_SECONDS} seconds`],
  });
  return result.rows as unknown as ConnectedUser[];
}

// --- Registro de eventos ---

export async function logEvent(
  nivel: LogLevel,
  mensaje: string,
  usuario?: string | null,
): Promise<void> {
  try {
    await client.execute({
      sql: "INSERT INTO app_logs (nivel, mensaje, usuario) VALUES (?1, ?2, ?3)",
      args: [nivel, mensaje, usuario ?? null],
    });
  } catch {
    // El registro nunca debe romper la aplicación.
  }
}

// Para eventos asociados a una acción de un usuario ya autenticado: resuelve
// el username desde la sesión verificada en la BD en vez de confiar en el
// string que arme el llamador (mismo motivo que assertActorSession/
// assertActorAuthorized). No usar para eventos que ocurren antes de tener
// una sesión válida (login fallido/bloqueado, restaurar sesión al abrir la
// app) — ahí no hay Actor que verificar, logEvent() sigue aceptando el
// string libre. Best-effort como logEvent(): un actor vencido/inválido no
// debe romper el flujo que está intentando registrar el evento, solo
// registra el evento sin usuario.
export async function logEventAsActor(actor: Actor, nivel: LogLevel, mensaje: string): Promise<void> {
  let usuario: string | null = null;
  try {
    const row = await loadActorSession(actor);
    usuario = row?.username ?? null;
  } catch {
    // best-effort, ver arriba.
  }
  await logEvent(nivel, mensaje, usuario);
}

export async function getRecentLogs(actor: Actor, limit = 200): Promise<AppLog[]> {
  await assertActorAuthorized(actor, "configuraciones");
  const result = await client.execute({
    sql: "SELECT * FROM app_logs ORDER BY id DESC LIMIT ?1",
    args: [limit],
  });
  return result.rows as unknown as AppLog[];
}

// Capacidad manual aceptada (ver docs/ARCHITECTURE.md), no expuesta desde
// LogsPanel (solo lectura por diseño) — exige Actor admin.
export async function clearLogs(actor: Actor): Promise<void> {
  await assertActorAuthorized(actor);
  await client.execute("DELETE FROM app_logs");
}

// --- Plásticos ---

interface PlasticPieceRow {
  id: number;
  product_id: number;
  sku: string;
  color: string;
  imagen: ArrayBuffer | null;
  imagen_mime: string | null;
  orden: number;
}

export async function getPlasticPieces(
  productId: number,
): Promise<PlasticPiece[]> {
  const result = await client.execute({
    sql: "SELECT * FROM product_plastic_pieces WHERE product_id = ?1 ORDER BY orden, id",
    args: [productId],
  });
  return (result.rows as unknown as PlasticPieceRow[]).map((row) => ({
    id: row.id,
    product_id: row.product_id,
    sku: row.sku,
    color: row.color,
    imagen: toImageBlob(row.imagen, row.imagen_mime),
    orden: row.orden,
  }));
}

export async function savePlasticPieces(
  productId: number,
  pieces: PlasticPiece[],
): Promise<void> {
  const tx = await client.transaction("write");
  try {
    await tx.execute({
      sql: "DELETE FROM product_plastic_pieces WHERE product_id = ?1",
      args: [productId],
    });
    let orden = 1;
    for (const piece of pieces) {
      const sku = piece.sku.trim();
      if (!sku) continue;
      await tx.execute({
        sql: `INSERT INTO product_plastic_pieces (product_id, sku, color, imagen, imagen_mime, orden)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        args: [
          productId,
          sku,
          piece.color.trim(),
          piece.imagen?.data ?? null,
          piece.imagen?.mime ?? null,
          orden,
        ],
      });
      orden += 1;
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}

// --- Plásticos (catálogo reutilizable) ---

interface PlasticProductRow {
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
  maquila: string;
  coste: string;
  componentes_fabricacion: string;
  dimensiones_empaque: string;
  imagen: ArrayBuffer | null;
  imagen_mime: string | null;
  creado_en: string;
}

function rowToPlasticProduct(row: PlasticProductRow): PlasticProduct {
  return {
    id: row.id,
    nombre: row.nombre,
    sku: row.sku,
    color: row.color,
    origen: row.origen,
    descripcion: row.descripcion,
    material: row.armado,
    dimension: row.dimension,
    peso: row.peso,
    tipo_empaque: row.tipo_empaque,
    maquila: row.maquila,
    coste: row.coste,
    componentes_fabricacion: row.componentes_fabricacion,
    dimensiones_empaque: row.dimensiones_empaque,
    imagen: toImageBlob(row.imagen, row.imagen_mime),
    creado_en: row.creado_en,
  };
}

function plasticProductToData(product: PlasticProduct): PlasticProductInput {
  return {
    nombre: product.nombre,
    sku: product.sku,
    color: product.color,
    origen: product.origen,
    descripcion: product.descripcion,
    material: product.material,
    dimension: product.dimension,
    peso: product.peso,
    tipo_empaque: product.tipo_empaque,
    maquila: product.maquila,
    coste: product.coste,
    componentes_fabricacion: product.componentes_fabricacion,
    dimensiones_empaque: product.dimensiones_empaque,
    imagen: product.imagen,
  };
}

export async function searchPlasticProducts(
  query: string,
): Promise<PlasticProduct[]> {
  const trimmed = query.trim();
  const result = trimmed
    ? await client.execute({
        sql: `SELECT * FROM plastic_products
              WHERE ${foldSearchColumn("nombre")} LIKE ?1 OR ${foldSearchColumn("sku")} LIKE ?1 OR ${foldSearchColumn("color")} LIKE ?1
              ORDER BY nombre, sku`,
        args: [`%${normalizeSearchTerm(trimmed)}%`],
      })
    : await client.execute("SELECT * FROM plastic_products ORDER BY nombre, sku");
  return (result.rows as unknown as PlasticProductRow[]).map(rowToPlasticProduct);
}

// Sin las columnas de imagen (BLOB) — mismo criterio que PRODUCT_LIST_COLUMNS
// arriba. Con más de 2600 piezas y ~48MB acumulados en las que sí tienen
// imagen, traerlas todas en pantallas que solo listan texto (PiezasGeneralSection,
// SkuMasterSection) es la causa real de que esas dos pantallas tarden en
// cargar. `searchPlasticProducts` (con imagen) sigue existiendo tal cual para
// PlasticProductPicker/PlasticosSection, que sí necesitan la imagen porque la
// reenvían a `updatePlasticProduct` al vincular una pieza existente a una
// ficha — cambiar esa función habría borrado imágenes existentes en silencio.
const PLASTIC_PRODUCT_LIST_COLUMNS =
  "id, nombre, sku, color, origen, descripcion, armado, dimension, peso, tipo_empaque, maquila, coste, componentes_fabricacion, dimensiones_empaque, creado_en";

export async function listPlasticProductsSummary(): Promise<PlasticProduct[]> {
  const result = await client.execute(
    `SELECT ${PLASTIC_PRODUCT_LIST_COLUMNS} FROM plastic_products ORDER BY nombre, sku`,
  );
  return (result.rows as unknown as PlasticProductRow[]).map(rowToPlasticProduct);
}

export async function getPlasticProduct(id: number): Promise<PlasticProduct | null> {
  const result = await client.execute({
    sql: "SELECT * FROM plastic_products WHERE id = ?1",
    args: [id],
  });
  const row = result.rows[0] as unknown as PlasticProductRow | undefined;
  return row ? rowToPlasticProduct(row) : null;
}

// Fichas técnicas que tienen esta pieza vinculada (join inverso de
// product_plastic_items) — usado en la pantalla de detalle de Piezas General
// para mostrar dónde se usa antes de editarla/borrarla.
export interface ProductUsingPlasticRow {
  id: number;
  codigo: string;
  nombre: string;
}

export async function getProductsUsingPlasticProduct(
  plasticProductId: number,
): Promise<ProductUsingPlasticRow[]> {
  const result = await client.execute({
    sql: `SELECT p.id AS id, p.codigo AS codigo, p.nombre AS nombre
          FROM product_plastic_items ppi
          JOIN products p ON p.id = ppi.product_id
          WHERE ppi.plastic_product_id = ?1
          ORDER BY p.nombre`,
    args: [plasticProductId],
  });
  return result.rows as unknown as ProductUsingPlasticRow[];
}

// Borra la pieza del catálogo maestro y la desvincula de cualquier ficha que
// la tuviera (mismo criterio que deleteProduct: borrado real, sin flag,
// atómico vía transacción).
export async function deletePlasticProduct(actor: Actor, id: number): Promise<void> {
  await assertActorAuthorized(actor, "plasticos");
  const tx = await client.transaction("write");
  try {
    await tx.execute({
      sql: "DELETE FROM product_plastic_items WHERE plastic_product_id = ?1",
      args: [id],
    });
    await tx.execute({
      sql: "DELETE FROM plastic_products WHERE id = ?1",
      args: [id],
    });
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}

export async function createPlasticProduct(
  actor: Actor,
  input: PlasticProductInput,
  executor: Executor = client,
): Promise<number> {
  await assertActorAuthorized(actor, "plasticos");
  const result = await executor.execute({
    sql: `INSERT INTO plastic_products
          (nombre, sku, color, origen, descripcion, armado, dimension, peso, tipo_empaque, maquila, coste, componentes_fabricacion, dimensiones_empaque, imagen, imagen_mime)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
    args: [
      input.nombre.trim(),
      input.sku.trim(),
      input.color.trim(),
      input.origen.trim(),
      input.descripcion.trim(),
      input.material.trim(),
      input.dimension.trim(),
      input.peso.trim(),
      input.tipo_empaque.trim(),
      input.maquila.trim(),
      input.coste.trim(),
      input.componentes_fabricacion.trim(),
      input.dimensiones_empaque.trim(),
      input.imagen?.data ?? null,
      input.imagen?.mime ?? null,
    ],
  });
  return Number(result.lastInsertRowid);
}

export async function updatePlasticProduct(
  actor: Actor,
  id: number,
  input: PlasticProductInput,
  executor: Executor = client,
): Promise<void> {
  await assertActorAuthorized(actor, "plasticos");
  await executor.execute({
    sql: `UPDATE plastic_products
          SET nombre = ?1, sku = ?2, color = ?3, origen = ?4, descripcion = ?5, armado = ?6,
              dimension = ?7, peso = ?8, tipo_empaque = ?9, maquila = ?10, coste = ?11,
              componentes_fabricacion = ?12, dimensiones_empaque = ?13, imagen = ?14, imagen_mime = ?15
          WHERE id = ?16`,
    args: [
      input.nombre.trim(),
      input.sku.trim(),
      input.color.trim(),
      input.origen.trim(),
      input.descripcion.trim(),
      input.material.trim(),
      input.dimension.trim(),
      input.peso.trim(),
      input.tipo_empaque.trim(),
      input.maquila.trim(),
      input.coste.trim(),
      input.componentes_fabricacion.trim(),
      input.dimensiones_empaque.trim(),
      input.imagen?.data ?? null,
      input.imagen?.mime ?? null,
      id,
    ],
  });
}

// Usada exclusivamente por SkuMasterSection: su único propósito ahí es
// asignar/corregir el SKU de una pieza, no editarla — antes reusaba
// updatePlasticProduct() con un spread de todos los campos ya cargados en
// memoria (plasticProductToInput(pieza)), así que si alguien más editaba esa
// misma pieza entre que SKU Master cargó su lista y que se guardó el SKU, ese
// cambio se pisaba silenciosamente con los datos obsoletos. Esta variante
// solo toca la columna sku, y solo exige el permiso sku_master (no plasticos,
// que es un permiso más amplio que esta acción puntual no necesita).
export async function updatePlasticProductSku(actor: Actor, id: number, sku: string): Promise<void> {
  await assertActorAuthorized(actor, "sku_master");
  await client.execute({
    sql: "UPDATE plastic_products SET sku = ?1 WHERE id = ?2",
    args: [sku.trim(), id],
  });
}

interface PlasticItemRow extends PlasticProductRow {
  item_id: number;
  item_orden: number;
}

export async function getPlasticItems(productId: number): Promise<PlasticItem[]> {
  const result = await client.execute({
    sql: `SELECT ppi.id AS item_id, ppi.orden AS item_orden, pp.*
          FROM product_plastic_items ppi
          JOIN plastic_products pp ON pp.id = ppi.plastic_product_id
          WHERE ppi.product_id = ?1
          ORDER BY ppi.orden, ppi.id`,
    args: [productId],
  });
  return (result.rows as unknown as PlasticItemRow[]).map((row) => ({
    id: row.item_id,
    product_id: productId,
    plastic_product_id: row.id,
    orden: row.item_orden,
    data: plasticProductToData(rowToPlasticProduct(row)),
  }));
}

export async function savePlasticItems(
  actor: Actor,
  productId: number,
  items: PlasticItem[],
): Promise<void> {
  await assertActorAuthorized(actor, "plasticos");
  const tx = await client.transaction("write");
  try {
    const resolved: { plasticProductId: number; orden: number }[] = [];
    let orden = 1;
    for (const item of items) {
      if (!item.data.nombre.trim() && !item.data.sku.trim()) continue;
      let plasticProductId: number;
      if (item.plastic_product_id) {
        plasticProductId = item.plastic_product_id;
        await updatePlasticProduct(actor, plasticProductId, item.data, tx);
      } else {
        plasticProductId = await createPlasticProduct(actor, item.data, tx);
      }
      resolved.push({ plasticProductId, orden });
      orden += 1;
    }
    await tx.execute({
      sql: "DELETE FROM product_plastic_items WHERE product_id = ?1",
      args: [productId],
    });
    for (const { plasticProductId, orden: itemOrden } of resolved) {
      await tx.execute({
        sql: `INSERT INTO product_plastic_items (product_id, plastic_product_id, orden) VALUES (?1, ?2, ?3)`,
        args: [productId, plasticProductId, itemOrden],
      });
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}

// Busca una pieza por nombre exacto (sin distinguir mayúsculas/espacios),
// pero solo entre las ya ligadas a ese juego específico. Usada cuando la
// fila de importación no trae SKU propio — el criterio de "ya existe" pasa
// a ser juego + nombre.
export async function findPlasticProductInJuegoByNombre(
  nombre: string,
  productId: number,
): Promise<PlasticProduct | null> {
  const result = await client.execute({
    sql: `SELECT pp.* FROM plastic_products pp
          JOIN product_plastic_items ppi ON ppi.plastic_product_id = pp.id
          WHERE ppi.product_id = ?1 AND LOWER(TRIM(pp.nombre)) = LOWER(TRIM(?2))
          LIMIT 1`,
    args: [productId, nombre],
  });
  const row = result.rows[0] as unknown as PlasticProductRow | undefined;
  return row ? rowToPlasticProduct(row) : null;
}

// Busca una pieza por SKU exacto, pero solo entre las ya ligadas a ese juego
// específico — plastic_products.sku no es único (la misma pieza puede
// repetirse en distintos juegos como filas separadas), así que "ya existe"
// para efectos de importación masiva significa SKU + juego, no SKU solo.
// Usada cuando la fila de importación sí trae SKU propio (ej. "1138-1",
// asignado por la empresa como sub-SKU del juego, o un SKU reutilizado de
// otro contexto como "3346-17").
export async function findPlasticProductInJuegoBySku(
  sku: string,
  productId: number,
): Promise<PlasticProduct | null> {
  const result = await client.execute({
    sql: `SELECT pp.* FROM plastic_products pp
          JOIN product_plastic_items ppi ON ppi.plastic_product_id = pp.id
          WHERE ppi.product_id = ?1 AND pp.sku = ?2
          LIMIT 1`,
    args: [productId, sku.trim()],
  });
  const row = result.rows[0] as unknown as PlasticProductRow | undefined;
  return row ? rowToPlasticProduct(row) : null;
}

// Upsert incremental de una fila de importación masiva de piezas: a
// diferencia de savePlasticItems (que reemplaza TODA la relación de un
// juego), esta función solo crea/actualiza una pieza puntual sin tocar el
// resto de piezas ya ligadas al juego que no vinieron en el Excel.
// `productId` es null cuando la fila no se pudo relacionar con ningún juego
// pero el usuario decidió importarla igual — la pieza se crea/actualiza en
// el catálogo maestro sin fila en product_plastic_items.
export async function importPiezaRow(
  actor: Actor,
  productId: number | null,
  plasticProductId: number | null,
  input: PlasticProductInput,
  orden: number,
): Promise<number> {
  await assertActorAuthorized(actor, "plasticos");
  const tx = await client.transaction("write");
  try {
    let resolvedId: number;
    if (plasticProductId) {
      await updatePlasticProduct(actor, plasticProductId, input, tx);
      resolvedId = plasticProductId;
    } else {
      resolvedId = await createPlasticProduct(actor, input, tx);
      if (productId !== null) {
        await tx.execute({
          sql: `INSERT INTO product_plastic_items (product_id, plastic_product_id, orden) VALUES (?1, ?2, ?3)`,
          args: [productId, resolvedId, orden],
        });
      }
    }
    await tx.commit();
    return resolvedId;
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}

// --- Lotes de importación masiva de piezas (para poder deshacer) ---

export interface PiezaImportBatch {
  id: number;
  creado_en: string;
  creado_por: string | null;
  total: number;
}

// Registra qué piezas se CREARON (no las actualizadas — esas no se pueden
// deshacer sin perder los datos previos) en una corrida de importación
// masiva, para que "Eliminar última importación masiva" sepa exactamente
// qué borrar. No hace nada si la lista viene vacía (nada que deshacer).
export async function recordPiezaImportBatch(actor: Actor, plasticProductIds: number[]): Promise<void> {
  if (plasticProductIds.length === 0) return;
  await assertActorAuthorized(actor, "plasticos");
  const usuario = (await loadActorSession(actor))?.username ?? null;
  await client.execute({
    sql: `INSERT INTO piezas_import_batches (creado_por, plastic_product_ids, total) VALUES (?1, ?2, ?3)`,
    args: [usuario, JSON.stringify(plasticProductIds), plasticProductIds.length],
  });
}

// Último lote de importación de piezas que todavía no se deshizo — null si
// no hay ninguno (nunca se importó, o ya se deshizo el más reciente).
export async function getLastPiezaImportBatch(): Promise<PiezaImportBatch | null> {
  const result = await client.execute(
    `SELECT id, creado_en, creado_por, total FROM piezas_import_batches
     WHERE deshecho_en IS NULL
     ORDER BY id DESC LIMIT 1`,
  );
  const row = result.rows[0] as unknown as PiezaImportBatch | undefined;
  return row ?? null;
}

// Borra las piezas creadas por el último lote de importación no deshecho
// (y su relación con el juego, si tenían) y marca el lote como deshecho —
// no se puede deshacer dos veces el mismo lote. Atómico: si una pieza del
// lote ya se había borrado manualmente antes, el DELETE simplemente no
// afecta esa fila, sin error.
export async function undoLastPiezaImportBatch(actor: Actor): Promise<{ eliminadas: number }> {
  await assertActorAuthorized(actor, "plasticos");
  const tx = await client.transaction("write");
  try {
    const result = await tx.execute(
      `SELECT id, plastic_product_ids FROM piezas_import_batches
       WHERE deshecho_en IS NULL
       ORDER BY id DESC LIMIT 1`,
    );
    const row = result.rows[0] as unknown as { id: number; plastic_product_ids: string } | undefined;
    if (!row) {
      throw new Error("No hay ninguna importación de piezas para deshacer.");
    }
    const ids = JSON.parse(row.plastic_product_ids) as number[];
    let eliminadas = 0;
    if (ids.length > 0) {
      const placeholders = ids.map((_, i) => `?${i + 1}`).join(", ");
      await tx.execute({
        sql: `DELETE FROM product_plastic_items WHERE plastic_product_id IN (${placeholders})`,
        args: ids,
      });
      const deleteResult = await tx.execute({
        sql: `DELETE FROM plastic_products WHERE id IN (${placeholders})`,
        args: ids,
      });
      eliminadas = deleteResult.rowsAffected;
    }
    await tx.execute({
      sql: `UPDATE piezas_import_batches SET deshecho_en = datetime('now') WHERE id = ?1`,
      args: [row.id],
    });
    await tx.commit();
    return { eliminadas };
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}

// --- Maderas (catálogo reutilizable, mismo patrón que Piezas) ---

interface WoodProductRow {
  id: number;
  nombre: string;
  sku: string;
  tamano: string;
  capas: string;
  largo: string;
  ancho: string;
  espesor: string;
  caben_hoja_mdf: string;
  minutos_laser: string;
  importe_madera: number | null;
  pintura: number | null;
  importe_corte_laser: number | null;
  etiqueta_adhesiva: number | null;
  otro_importe: number | null;
  otro_concepto: string;
  etiqueta_empaque: number | null;
  costo_total: number | null;
  precio_venta: number | null;
  imagen: ArrayBuffer | null;
  imagen_mime: string | null;
  creado_en: string;
}

function rowToWoodProduct(row: WoodProductRow): WoodProduct {
  return {
    id: row.id,
    nombre: row.nombre,
    sku: row.sku,
    tamano: row.tamano,
    capas: row.capas,
    largo: row.largo,
    ancho: row.ancho,
    espesor: row.espesor,
    caben_hoja_mdf: row.caben_hoja_mdf,
    minutos_laser: row.minutos_laser,
    importe_madera: row.importe_madera,
    pintura: row.pintura,
    importe_corte_laser: row.importe_corte_laser,
    etiqueta_adhesiva: row.etiqueta_adhesiva,
    otro_importe: row.otro_importe,
    otro_concepto: row.otro_concepto,
    etiqueta_empaque: row.etiqueta_empaque,
    costo_total: row.costo_total,
    precio_venta: row.precio_venta,
    imagen: toImageBlob(row.imagen, row.imagen_mime),
    creado_en: row.creado_en,
  };
}

function woodProductToData(product: WoodProduct): WoodProductInput {
  return {
    nombre: product.nombre,
    sku: product.sku,
    tamano: product.tamano,
    capas: product.capas,
    largo: product.largo,
    ancho: product.ancho,
    espesor: product.espesor,
    caben_hoja_mdf: product.caben_hoja_mdf,
    minutos_laser: product.minutos_laser,
    importe_madera: product.importe_madera,
    pintura: product.pintura,
    importe_corte_laser: product.importe_corte_laser,
    etiqueta_adhesiva: product.etiqueta_adhesiva,
    otro_importe: product.otro_importe,
    otro_concepto: product.otro_concepto,
    etiqueta_empaque: product.etiqueta_empaque,
    costo_total: product.costo_total,
    precio_venta: product.precio_venta,
    imagen: product.imagen,
  };
}

// Usada por WoodProductPicker ("Agregar un producto existente" dentro de
// Maderas) — igual que searchPlasticProducts, sin Actor (lectura abierta).
export async function searchWoodProducts(query: string): Promise<WoodProduct[]> {
  const trimmed = query.trim();
  const result = trimmed
    ? await client.execute({
        sql: `SELECT * FROM wood_products
              WHERE ${foldSearchColumn("nombre")} LIKE ?1 OR ${foldSearchColumn("sku")} LIKE ?1
              ORDER BY nombre, sku`,
        args: [`%${normalizeSearchTerm(trimmed)}%`],
      })
    : await client.execute("SELECT * FROM wood_products ORDER BY nombre, sku");
  return (result.rows as unknown as WoodProductRow[]).map(rowToWoodProduct);
}

export async function createWoodProduct(
  actor: Actor,
  input: WoodProductInput,
  executor: Executor = client,
): Promise<number> {
  await assertActorAuthorized(actor, "maderas");
  const result = await executor.execute({
    sql: `INSERT INTO wood_products
          (nombre, sku, tamano, capas, largo, ancho, espesor, caben_hoja_mdf, minutos_laser,
           importe_madera, pintura, importe_corte_laser, etiqueta_adhesiva, otro_importe, otro_concepto,
           etiqueta_empaque, costo_total, precio_venta, imagen, imagen_mime)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)`,
    args: [
      input.nombre.trim(),
      input.sku.trim(),
      input.tamano.trim(),
      input.capas.trim(),
      input.largo.trim(),
      input.ancho.trim(),
      input.espesor.trim(),
      input.caben_hoja_mdf.trim(),
      input.minutos_laser.trim(),
      input.importe_madera,
      input.pintura,
      input.importe_corte_laser,
      input.etiqueta_adhesiva,
      input.otro_importe,
      input.otro_concepto.trim(),
      input.etiqueta_empaque,
      input.costo_total,
      input.precio_venta,
      input.imagen?.data ?? null,
      input.imagen?.mime ?? null,
    ],
  });
  return Number(result.lastInsertRowid);
}

export async function updateWoodProduct(
  actor: Actor,
  id: number,
  input: WoodProductInput,
  executor: Executor = client,
): Promise<void> {
  await assertActorAuthorized(actor, "maderas");
  await executor.execute({
    sql: `UPDATE wood_products
          SET nombre = ?1, sku = ?2, tamano = ?3, capas = ?4, largo = ?5, ancho = ?6, espesor = ?7,
              caben_hoja_mdf = ?8, minutos_laser = ?9, importe_madera = ?10, pintura = ?11,
              importe_corte_laser = ?12, etiqueta_adhesiva = ?13, otro_importe = ?14, otro_concepto = ?15,
              etiqueta_empaque = ?16, costo_total = ?17, precio_venta = ?18, imagen = ?19, imagen_mime = ?20
          WHERE id = ?21`,
    args: [
      input.nombre.trim(),
      input.sku.trim(),
      input.tamano.trim(),
      input.capas.trim(),
      input.largo.trim(),
      input.ancho.trim(),
      input.espesor.trim(),
      input.caben_hoja_mdf.trim(),
      input.minutos_laser.trim(),
      input.importe_madera,
      input.pintura,
      input.importe_corte_laser,
      input.etiqueta_adhesiva,
      input.otro_importe,
      input.otro_concepto.trim(),
      input.etiqueta_empaque,
      input.costo_total,
      input.precio_venta,
      input.imagen?.data ?? null,
      input.imagen?.mime ?? null,
      id,
    ],
  });
}

interface WoodItemRow extends WoodProductRow {
  item_id: number;
  item_orden: number;
}

export async function getWoodItems(productId: number): Promise<WoodItem[]> {
  const result = await client.execute({
    sql: `SELECT pwi.id AS item_id, pwi.orden AS item_orden, wp.*
          FROM product_wood_items pwi
          JOIN wood_products wp ON wp.id = pwi.wood_product_id
          WHERE pwi.product_id = ?1
          ORDER BY pwi.orden, pwi.id`,
    args: [productId],
  });
  return (result.rows as unknown as WoodItemRow[]).map((row) => ({
    id: row.item_id,
    product_id: productId,
    wood_product_id: row.id,
    orden: row.item_orden,
    data: woodProductToData(rowToWoodProduct(row)),
  }));
}

export async function saveWoodItems(actor: Actor, productId: number, items: WoodItem[]): Promise<void> {
  await assertActorAuthorized(actor, "maderas");
  const tx = await client.transaction("write");
  try {
    const resolved: { woodProductId: number; orden: number }[] = [];
    let orden = 1;
    for (const item of items) {
      if (!item.data.nombre.trim() && !item.data.sku.trim()) continue;
      let woodProductId: number;
      if (item.wood_product_id) {
        woodProductId = item.wood_product_id;
        await updateWoodProduct(actor, woodProductId, item.data, tx);
      } else {
        woodProductId = await createWoodProduct(actor, item.data, tx);
      }
      resolved.push({ woodProductId, orden });
      orden += 1;
    }
    await tx.execute({
      sql: "DELETE FROM product_wood_items WHERE product_id = ?1",
      args: [productId],
    });
    for (const { woodProductId, orden: itemOrden } of resolved) {
      await tx.execute({
        sql: `INSERT INTO product_wood_items (product_id, wood_product_id, orden) VALUES (?1, ?2, ?3)`,
        args: [productId, woodProductId, itemOrden],
      });
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}

// Busca una pieza de madera ya ligada a ese juego por nombre+tamaño (sin
// distinguir mayúsculas/espacios) — a diferencia de Piezas, el SKU de una
// fila de Maderas identifica al JUEGO (se repite en varias filas cuando un
// juego tiene varias piezas de madera distintas), no a la pieza individual,
// así que no sirve como criterio de "ya existe" por sí solo — ver
// src/maderaImport.ts.
export async function findWoodProductInJuegoByNombreTamano(
  nombre: string,
  tamano: string,
  productId: number,
): Promise<WoodProduct | null> {
  const result = await client.execute({
    sql: `SELECT wp.* FROM wood_products wp
          JOIN product_wood_items pwi ON pwi.wood_product_id = wp.id
          WHERE pwi.product_id = ?1
            AND LOWER(TRIM(wp.nombre)) = LOWER(TRIM(?2))
            AND LOWER(TRIM(wp.tamano)) = LOWER(TRIM(?3))
          LIMIT 1`,
    args: [productId, nombre, tamano],
  });
  const row = result.rows[0] as unknown as WoodProductRow | undefined;
  return row ? rowToWoodProduct(row) : null;
}

// Upsert incremental de una fila de importación masiva de maderas — mismo
// criterio que importPiezaRow: crea/actualiza solo esa pieza de madera sin
// tocar el resto de las ya ligadas al juego. `productId` null cuando la fila
// no se pudo relacionar con ningún juego (sin SKU, o SKU sin producto
// coincidente) pero el usuario decidió importarla igual.
export async function importWoodRow(
  actor: Actor,
  productId: number | null,
  woodProductId: number | null,
  input: WoodProductInput,
  orden: number,
): Promise<number> {
  await assertActorAuthorized(actor, "maderas");
  const tx = await client.transaction("write");
  try {
    let resolvedId: number;
    if (woodProductId) {
      await updateWoodProduct(actor, woodProductId, input, tx);
      resolvedId = woodProductId;
    } else {
      resolvedId = await createWoodProduct(actor, input, tx);
      if (productId !== null) {
        await tx.execute({
          sql: `INSERT INTO product_wood_items (product_id, wood_product_id, orden) VALUES (?1, ?2, ?3)`,
          args: [productId, resolvedId, orden],
        });
      }
    }
    await tx.commit();
    return resolvedId;
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}

// --- Lotes de importación masiva de maderas (para poder deshacer) ---

export interface MaderaImportBatch {
  id: number;
  creado_en: string;
  creado_por: string | null;
  total: number;
}

export async function recordMaderaImportBatch(actor: Actor, woodProductIds: number[]): Promise<void> {
  if (woodProductIds.length === 0) return;
  await assertActorAuthorized(actor, "maderas");
  const usuario = (await loadActorSession(actor))?.username ?? null;
  await client.execute({
    sql: `INSERT INTO madera_import_batches (creado_por, wood_product_ids, total) VALUES (?1, ?2, ?3)`,
    args: [usuario, JSON.stringify(woodProductIds), woodProductIds.length],
  });
}

export async function getLastMaderaImportBatch(): Promise<MaderaImportBatch | null> {
  const result = await client.execute(
    `SELECT id, creado_en, creado_por, total FROM madera_import_batches
     WHERE deshecho_en IS NULL
     ORDER BY id DESC LIMIT 1`,
  );
  const row = result.rows[0] as unknown as MaderaImportBatch | undefined;
  return row ?? null;
}

export async function undoLastMaderaImportBatch(actor: Actor): Promise<{ eliminadas: number }> {
  await assertActorAuthorized(actor, "maderas");
  const tx = await client.transaction("write");
  try {
    const result = await tx.execute(
      `SELECT id, wood_product_ids FROM madera_import_batches
       WHERE deshecho_en IS NULL
       ORDER BY id DESC LIMIT 1`,
    );
    const row = result.rows[0] as unknown as { id: number; wood_product_ids: string } | undefined;
    if (!row) {
      throw new Error("No hay ninguna importación de maderas para deshacer.");
    }
    const ids = JSON.parse(row.wood_product_ids) as number[];
    let eliminadas = 0;
    if (ids.length > 0) {
      const placeholders = ids.map((_, i) => `?${i + 1}`).join(", ");
      await tx.execute({
        sql: `DELETE FROM product_wood_items WHERE wood_product_id IN (${placeholders})`,
        args: ids,
      });
      const deleteResult = await tx.execute({
        sql: `DELETE FROM wood_products WHERE id IN (${placeholders})`,
        args: ids,
      });
      eliminadas = deleteResult.rowsAffected;
    }
    await tx.execute({
      sql: `UPDATE madera_import_batches SET deshecho_en = datetime('now') WHERE id = ?1`,
      args: [row.id],
    });
    await tx.commit();
    return { eliminadas };
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}

// --- Imprenta ---

interface PrintItemRow {
  id: number;
  product_id: number;
  nombre: string;
  tamano: string;
  tipo_papel: string;
  tintas: string | null;
  gramos_puntos: string | null;
  pliego: string | null;
  extendido: string;
  corte_cm: string;
  maquina: string | null;
  formacion: string | null;
  numero_pliegos: string | null;
  numero_placas: string | null;
  placas_existentes: string | null;
  acabados: string | null;
  notas: string;
  orden: number;
}

function normalizeChecks(existing: PrintItemCheck[]): PrintItemCheck[] {
  return PROCESOS_IMPRENTA.map((nombre, index) => {
    const match = existing.find(
      (check) => check.nombre.trim().toLowerCase() === nombre.toLowerCase(),
    );
    return { nombre, marcado: match?.marcado ?? false, orden: index + 1 };
  });
}

interface PrintItemImageRow {
  id: number;
  print_item_id: number;
  imagen: ArrayBuffer;
  imagen_mime: string;
  orden: number;
}

function rowToPrintItemImage(row: PrintItemImageRow): PrintItemImage {
  return {
    id: row.id,
    print_item_id: row.print_item_id,
    imagen: { data: new Uint8Array(row.imagen), mime: row.imagen_mime },
    orden: row.orden,
  };
}

export async function getPrintItems(productId: number): Promise<PrintItem[]> {
  const result = await client.execute({
    sql: "SELECT * FROM product_print_items WHERE product_id = ?1 ORDER BY orden, id",
    args: [productId],
  });
  const rows = result.rows as unknown as PrintItemRow[];
  // Un round-trip por fila en paralelo (Promise.all sobre todas las filas),
  // en vez de un for-loop que esperaba cada fila antes de pedir la
  // siguiente — con varios ítems de imprenta en una misma ficha, eso
  // serializaba N round-trips a Turso donde ninguno depende del anterior.
  return Promise.all(
    rows.map(async (row) => {
      const [checkResult, extraResult, imageResult] = await Promise.all([
        client.execute({
          sql: "SELECT * FROM product_print_item_checks WHERE print_item_id = ?1 ORDER BY orden, id",
          args: [row.id],
        }),
        client.execute({
          sql: "SELECT * FROM product_print_item_extras WHERE print_item_id = ?1 ORDER BY orden, id",
          args: [row.id],
        }),
        client.execute({
          sql: "SELECT * FROM product_print_item_images WHERE print_item_id = ?1 ORDER BY orden, id",
          args: [row.id],
        }),
      ]);
      const checks = (
        checkResult.rows as unknown as (Omit<PrintItemCheck, "marcado"> & {
          marcado: number;
        })[]
      ).map((check) => ({ ...check, marcado: Boolean(check.marcado) }));
      const extras = extraResult.rows as unknown as PrintItemExtra[];
      const images = (imageResult.rows as unknown as PrintItemImageRow[]).map(rowToPrintItemImage);
      return {
        id: row.id,
        product_id: row.product_id,
        nombre: row.nombre,
        tamano_extendido: row.extendido ?? "",
        tamano_final: row.tamano ?? "",
        tintas: row.tintas ?? "",
        tipo_papel: row.tipo_papel ?? "",
        gramos_puntos: row.gramos_puntos ?? "",
        pliego: row.pliego ?? "",
        cortes_tamano: row.corte_cm ?? "",
        maquina: row.maquina ?? "",
        formacion: row.formacion ?? "",
        numero_pliegos: row.numero_pliegos ?? "",
        numero_placas: row.numero_placas ?? "",
        placas_existentes: (row.placas_existentes as PlacasExistentes | null) ?? "",
        checks: normalizeChecks(checks),
        extras,
        images,
        acabados: row.acabados ?? "",
        notas: row.notas ?? "",
        orden: row.orden,
      };
    }),
  );
}

export async function savePrintItems(
  actor: Actor,
  productId: number,
  items: PrintItem[],
): Promise<void> {
  await assertActorAuthorized(actor, "imprenta");
  const existing = await client.execute({
    sql: "SELECT id FROM product_print_items WHERE product_id = ?1",
    args: [productId],
  });
  const existingIds = new Set(
    (existing.rows as unknown as { id: number }[]).map((r) => r.id),
  );
  const keptIds = new Set<number>();

  const tx = await client.transaction("write");
  try {
    let orden = 1;
    for (const item of items) {
      const nombre = item.nombre.trim();
      if (!nombre) continue;

      const values = [
        nombre,
        item.tamano_final.trim(),
        item.tipo_papel.trim(),
        item.tintas.trim(),
        item.gramos_puntos.trim(),
        item.pliego.trim(),
        item.tamano_extendido.trim(),
        item.cortes_tamano.trim(),
        item.maquina.trim(),
        item.formacion.trim(),
        item.numero_pliegos.trim(),
        item.acabados.trim(),
        item.notas.trim(),
        item.numero_placas.trim(),
        item.placas_existentes || null,
        orden,
      ];

      let printItemId: number;
      if (item.id && existingIds.has(item.id)) {
        await tx.execute({
          sql: `UPDATE product_print_items SET
                  nombre=?1, tamano=?2, tipo_papel=?3, tintas=?4, gramos_puntos=?5, pliego=?6,
                  extendido=?7, corte_cm=?8, maquina=?9, formacion=?10, numero_pliegos=?11,
                  acabados=?12, notas=?13, numero_placas=?14,
                  placas_existentes=?15, orden=?16
                WHERE id=?17`,
          args: [...values, item.id],
        });
        printItemId = item.id;
        keptIds.add(item.id);
      } else {
        const result = await tx.execute({
          sql: `INSERT INTO product_print_items (
                  nombre, tamano, tipo_papel, tintas, gramos_puntos, pliego, extendido, corte_cm,
                  maquina, formacion, numero_pliegos, acabados, notas, numero_placas,
                  placas_existentes, orden, product_id
                ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)`,
          args: [...values, productId],
        });
        printItemId = Number(result.lastInsertRowid);
      }

      await tx.execute({
        sql: "DELETE FROM product_print_item_checks WHERE print_item_id = ?1",
        args: [printItemId],
      });
      let checkOrden = 1;
      for (const check of item.checks) {
        await tx.execute({
          sql: `INSERT INTO product_print_item_checks (print_item_id, nombre, marcado, orden)
                VALUES (?1, ?2, ?3, ?4)`,
          args: [printItemId, check.nombre.trim(), check.marcado ? 1 : 0, checkOrden],
        });
        checkOrden += 1;
      }
      await tx.execute({
        sql: "DELETE FROM product_print_item_extras WHERE print_item_id = ?1",
        args: [printItemId],
      });
      let extraOrden = 1;
      for (const extra of item.extras) {
        const etiqueta = extra.etiqueta.trim();
        const valor = extra.valor.trim();
        if (!etiqueta || !valor) continue;
        await tx.execute({
          sql: `INSERT INTO product_print_item_extras (print_item_id, etiqueta, valor, orden)
                VALUES (?1, ?2, ?3, ?4)`,
          args: [printItemId, etiqueta, valor, extraOrden],
        });
        extraOrden += 1;
      }

      await tx.execute({
        sql: "DELETE FROM product_print_item_images WHERE print_item_id = ?1",
        args: [printItemId],
      });
      let imageOrden = 1;
      for (const image of item.images) {
        await tx.execute({
          sql: `INSERT INTO product_print_item_images (print_item_id, imagen, imagen_mime, orden)
                VALUES (?1, ?2, ?3, ?4)`,
          args: [printItemId, image.imagen.data, image.imagen.mime, imageOrden],
        });
        imageOrden += 1;
      }
      orden += 1;
    }

    for (const id of existingIds) {
      if (keptIds.has(id)) continue;
      await tx.execute({
        sql: "DELETE FROM product_print_item_checks WHERE print_item_id=?1",
        args: [id],
      });
      await tx.execute({
        sql: "DELETE FROM product_print_item_extras WHERE print_item_id=?1",
        args: [id],
      });
      await tx.execute({
        sql: "DELETE FROM product_print_item_images WHERE print_item_id=?1",
        args: [id],
      });
      await tx.execute({
        sql: `DELETE FROM product_print_item_purchases WHERE print_item_order_id IN
              (SELECT id FROM product_print_item_orders WHERE print_item_id = ?1)`,
        args: [id],
      });
      await tx.execute({
        sql: "DELETE FROM product_print_item_orders WHERE print_item_id=?1",
        args: [id],
      });
      await tx.execute({
        sql: "DELETE FROM product_print_items WHERE id=?1",
        args: [id],
      });
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}

// --- Órdenes de producción y compra (Imprenta) ---

interface PrintItemOrderRow {
  id: number;
  print_item_id: number;
  merma: number;
  cantidad_arte: number;
  numero_tiros: number | null;
  formacion_usada: number;
  numero_pliegos_usado: number;
  total_pliegos: number;
  usuario: string | null;
  folio: string | null;
  creado_en: string;
}

export async function createPrintItemOrder(
  actor: Actor,
  printItemId: number,
  input: {
    merma: number;
    cantidadArte: number;
    numeroTiros: number;
    formacionUsada: number;
    numeroPliegosUsado: number;
    totalPliegos: number;
    folio: string;
  },
): Promise<PrintItemOrder> {
  const username = await assertActorAuthorized(actor, "imprenta");
  const result = await client.execute({
    sql: `INSERT INTO product_print_item_orders
          (print_item_id, merma, cantidad_arte, numero_tiros, formacion_usada, numero_pliegos_usado, total_pliegos, usuario, folio)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
    args: [
      printItemId,
      input.merma,
      input.cantidadArte,
      input.numeroTiros,
      input.formacionUsada,
      input.numeroPliegosUsado,
      input.totalPliegos,
      username,
      input.folio,
    ],
  });
  return {
    id: Number(result.lastInsertRowid),
    print_item_id: printItemId,
    merma: input.merma,
    cantidad_arte: input.cantidadArte,
    numero_tiros: input.numeroTiros,
    formacion_usada: input.formacionUsada,
    numero_pliegos_usado: input.numeroPliegosUsado,
    total_pliegos: input.totalPliegos,
    usuario: username,
    folio: input.folio,
    creado_en: new Date().toISOString(),
  };
}

export async function getPrintItemOrders(printItemId: number): Promise<PrintItemOrder[]> {
  const result = await client.execute({
    sql: "SELECT * FROM product_print_item_orders WHERE print_item_id = ?1 ORDER BY id DESC",
    args: [printItemId],
  });
  return result.rows as unknown as PrintItemOrderRow[] as PrintItemOrder[];
}

interface PrintItemPurchaseRow {
  id: number;
  print_item_order_id: number;
  papel: string;
  pliego: string;
  maquina: string;
  cortes: number;
  cantidad: number;
  total_tamanos: number;
  usuario: string | null;
  folio: string | null;
  creado_en: string;
}

export async function createPrintItemPurchase(
  actor: Actor,
  printItemOrderId: number,
  input: {
    papel: string;
    pliego: string;
    maquina: string;
    cortes: number;
    cantidad: number;
    totalTamanos: number;
    folio: string;
  },
): Promise<PrintItemPurchase> {
  const username = await assertActorAuthorized(actor, "imprenta");
  const result = await client.execute({
    sql: `INSERT INTO product_print_item_purchases
          (print_item_order_id, papel, pliego, maquina, cortes, cantidad, total_tamanos, usuario, folio)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
    args: [
      printItemOrderId,
      input.papel,
      input.pliego,
      input.maquina,
      input.cortes,
      input.cantidad,
      input.totalTamanos,
      username,
      input.folio,
    ],
  });
  return {
    id: Number(result.lastInsertRowid),
    print_item_order_id: printItemOrderId,
    papel: input.papel,
    pliego: input.pliego,
    maquina: input.maquina,
    cortes: input.cortes,
    cantidad: input.cantidad,
    total_tamanos: input.totalTamanos,
    usuario: username,
    folio: input.folio,
    creado_en: new Date().toISOString(),
  };
}

// Usada por la "compra general" de OrderModal (varios ítems a la vez): antes
// insertaba una compra por ítem con try/catch individual, seguía adelante si
// una fallaba, y reportaba éxito igual — el PDF podía terminar listando
// compras que nunca quedaron guardadas. Todo o nada: si un ítem falla,
// ninguno queda escrito, para que el caller nunca reporte éxito con registros
// faltantes.
export async function createPrintItemPurchasesBatch(
  actor: Actor,
  entries: {
    printItemOrderId: number;
    papel: string;
    pliego: string;
    maquina: string;
    cortes: number;
    cantidad: number;
    totalTamanos: number;
    folio: string;
  }[],
): Promise<PrintItemPurchase[]> {
  const username = await assertActorAuthorized(actor, "imprenta");
  const tx = await client.transaction("write");
  try {
    const results: PrintItemPurchase[] = [];
    for (const entry of entries) {
      const result = await tx.execute({
        sql: `INSERT INTO product_print_item_purchases
              (print_item_order_id, papel, pliego, maquina, cortes, cantidad, total_tamanos, usuario, folio)
              VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
        args: [
          entry.printItemOrderId,
          entry.papel,
          entry.pliego,
          entry.maquina,
          entry.cortes,
          entry.cantidad,
          entry.totalTamanos,
          username,
          entry.folio,
        ],
      });
      results.push({
        id: Number(result.lastInsertRowid),
        print_item_order_id: entry.printItemOrderId,
        papel: entry.papel,
        pliego: entry.pliego,
        maquina: entry.maquina,
        cortes: entry.cortes,
        cantidad: entry.cantidad,
        total_tamanos: entry.totalTamanos,
        usuario: username,
        folio: entry.folio,
        creado_en: new Date().toISOString(),
      });
    }
    await tx.commit();
    return results;
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}

export async function getPrintItemPurchases(
  printItemOrderId: number,
): Promise<PrintItemPurchase[]> {
  const result = await client.execute({
    sql: "SELECT * FROM product_print_item_purchases WHERE print_item_order_id = ?1 ORDER BY id DESC",
    args: [printItemOrderId],
  });
  return result.rows as unknown as PrintItemPurchaseRow[] as PrintItemPurchase[];
}

export async function deletePrintItemOrder(actor: Actor, orderId: number): Promise<void> {
  await assertActorAuthorized(actor, "imprenta");
  const tx = await client.transaction("write");
  try {
    await tx.execute({
      sql: "DELETE FROM product_print_item_purchases WHERE print_item_order_id = ?1",
      args: [orderId],
    });
    await tx.execute({
      sql: "DELETE FROM product_print_item_orders WHERE id = ?1",
      args: [orderId],
    });
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}

export async function deletePrintItemPurchase(actor: Actor, purchaseId: number): Promise<void> {
  await assertActorAuthorized(actor, "imprenta");
  await client.execute({
    sql: "DELETE FROM product_print_item_purchases WHERE id = ?1",
    args: [purchaseId],
  });
}

// --- Folios (sistema centralizado, usado por requisiciones/compras/producción) ---

interface FolioRow {
  id: number;
  seccion: string;
  consecutivo: number;
  folio: string;
  sku: string;
  creado_en: string;
}

// Compartida por createFolio() (fuera de transacción, usada por los flujos
// Compra/Producción/Requisición que necesitan el folio ya "quemado" antes de
// un diálogo de guardado de PDF que puede tardar o cancelarse) y por las
// variantes *ConFolio de abajo, que la corren dentro de un client.transaction
// junto con el INSERT del documento — así folio y documento se confirman o
// se revierten juntos, sin dejar un folio huérfano si el segundo INSERT falla.
async function insertFolioRow(
  execer: Client | Transaction,
  tipo: TipoFolio,
  sku: string,
): Promise<Folio> {
  // consecutivo se calcula dentro del mismo INSERT (subconsulta), no en un
  // SELECT previo por separado — mismo patrón que requisiciones.numero_dia,
  // mismo motivo (SQLite/libSQL serializa las escrituras). Acá el scope es
  // `seccion`, no `fecha`: el consecutivo de folios nunca se reinicia.
  const insertResult = await execer.execute({
    sql: `INSERT INTO folios (seccion, consecutivo, sku)
          VALUES (?1, (SELECT COALESCE(MAX(consecutivo), 0) + 1 FROM folios WHERE seccion = ?1), ?2)
          RETURNING *`,
    args: [tipo, sku],
  });
  const row = insertResult.rows[0] as unknown as FolioRow;
  // El folio queda "congelado" con el sku al momento de crearse — si el
  // código del producto cambia después, el folio histórico no se actualiza;
  // es intencional, es un documento inmutable.
  const folio = buildFolioString(FOLIO_PREFIJOS[tipo], sku, formatFechaFolioLocal(), row.consecutivo);
  await execer.execute({
    sql: "UPDATE folios SET folio = ?1 WHERE id = ?2",
    args: [folio, row.id],
  });
  return { id: row.id, seccion: tipo, consecutivo: row.consecutivo, folio, sku, creado_en: row.creado_en };
}

export async function createFolio(tipo: TipoFolio, sku: string): Promise<Folio> {
  return insertFolioRow(client, tipo, sku);
}

// --- Requisiciones de bodega ---

interface RequisicionRow {
  id: number;
  product_id: number;
  fecha: string;
  numero_dia: number;
  usuario: string | null;
  etiqueta: string;
  descripcion: string | null;
  cantidad: number;
  estado: string;
  mensaje: string;
  folio: string | null;
  creado_en: string;
}

function rowToRequisicion(row: RequisicionRow): Requisicion {
  return {
    id: row.id,
    product_id: row.product_id,
    fecha: row.fecha,
    numero_dia: row.numero_dia,
    usuario: row.usuario,
    etiqueta: row.etiqueta,
    descripcion: row.descripcion ?? "",
    cantidad: row.cantidad,
    estado: row.estado as EstadoRequisicion,
    mensaje: row.mensaje,
    folio: row.folio ?? "",
    creado_en: row.creado_en,
  };
}

export async function createRequisicion(
  actor: Actor,
  input: RequisicionInput,
): Promise<Requisicion> {
  const usuario = await assertActorAuthorized(actor, "requisiciones");
  const fecha = fechaLocalDeHoy();
  // numero_dia se calcula dentro del mismo INSERT (subconsulta), no en un
  // SELECT previo por separado: SQLite/libSQL serializa las escrituras, así
  // que un único statement evita que dos requisiciones simultáneas obtengan
  // el mismo consecutivo.
  const insertResult = await client.execute({
    sql: `INSERT INTO requisiciones
            (product_id, fecha, numero_dia, usuario, etiqueta, descripcion, cantidad, estado, mensaje, folio)
          VALUES (
            ?1, ?2,
            (SELECT COALESCE(MAX(numero_dia), 0) + 1 FROM requisiciones WHERE fecha = ?2),
            ?3, ?4, ?5, ?6, 'pendiente', '', ?7
          )
          RETURNING *`,
    args: [
      input.productId,
      fecha,
      usuario,
      input.etiqueta,
      input.descripcion,
      input.cantidad,
      input.folio,
    ],
  });
  const row = insertResult.rows[0] as unknown as RequisicionRow;
  const mensaje = buildRequisicionMessage(
    row.numero_dia,
    row.cantidad,
    row.etiqueta,
    input.productNombre,
    input.productCodigo,
  );
  await client.execute({
    sql: "UPDATE requisiciones SET mensaje = ?1 WHERE id = ?2",
    args: [mensaje, row.id],
  });
  return rowToRequisicion({ ...row, mensaje });
}

// Igual que createRequisicion(), pero genera el folio dentro de la misma
// transacción en vez de recibirlo ya creado — usar esta variante quita la
// ventana entre "folio consumido" y "requisición guardada" para los llamadores
// que no necesitan el folio antes (no arman un PDF con él antes del insert).
export async function createRequisicionConFolio(
  actor: Actor,
  sku: string,
  input: Omit<RequisicionInput, "folio">,
): Promise<Requisicion> {
  const usuario = await assertActorAuthorized(actor, "requisiciones");
  const fecha = fechaLocalDeHoy();
  const tx = await client.transaction("write");
  try {
    const folio = await insertFolioRow(tx, "requisicion", sku);
    const insertResult = await tx.execute({
      sql: `INSERT INTO requisiciones
              (product_id, fecha, numero_dia, usuario, etiqueta, descripcion, cantidad, estado, mensaje, folio)
            VALUES (
              ?1, ?2,
              (SELECT COALESCE(MAX(numero_dia), 0) + 1 FROM requisiciones WHERE fecha = ?2),
              ?3, ?4, ?5, ?6, 'pendiente', '', ?7
            )
            RETURNING *`,
      args: [
        input.productId,
        fecha,
        usuario,
        input.etiqueta,
        input.descripcion,
        input.cantidad,
        folio.folio,
      ],
    });
    const row = insertResult.rows[0] as unknown as RequisicionRow;
    const mensaje = buildRequisicionMessage(
      row.numero_dia,
      row.cantidad,
      row.etiqueta,
      input.productNombre,
      input.productCodigo,
    );
    await tx.execute({
      sql: "UPDATE requisiciones SET mensaje = ?1 WHERE id = ?2",
      args: [mensaje, row.id],
    });
    await tx.commit();
    return rowToRequisicion({ ...row, mensaje });
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}

// --- Backups ---

interface SqlExecutor {
  execute(sql: string): Promise<{ rows: unknown[] }>;
}

async function readTableDump(executor: SqlExecutor, name: string, createSql: string): Promise<DumpTable> {
  const columnsResult = await executor.execute(`PRAGMA table_info(${name})`);
  const columns = (columnsResult.rows as unknown as { name: string }[]).map((c) => c.name);
  const rowsResult = await executor.execute(`SELECT * FROM ${name}`);
  return {
    name,
    createSql,
    columns,
    rows: rowsResult.rows as unknown as Record<string, unknown>[],
  };
}

// products/plastic_products (imágenes BLOB, ~150MB en conjunto — medido
// contra Turso en producción) se leen aparte del resto, con una consulta
// suelta en vez de dentro de la transacción de más abajo: confirmado en
// producción que leer todas las tablas en una sola transacción tarda ~20s
// (más de la mitad solo estas dos), y en una red más lenta que la de
// oficina esa transacción interactiva se cierra sola del lado de Turso
// antes de llegar al commit — el rollback posterior falla con "cannot
// rollback - no transaction is active" porque ya no hay nada que deshacer.
// Una consulta suelta no arrastra ese límite de sesión. A cambio, estas dos
// tablas pueden quedar unos segundos más viejas/nuevas que el resto del
// dump en backups disparados desde la app — el automático programado
// (clio-backups, corre contra una red rápida) no tiene este problema y
// sigue leyendo todo con la misma consistencia de siempre.
const BACKUP_TABLES_FUERA_DE_TRANSACCION = ["products", "plastic_products"];

// Lee toda la BD (todas las tablas reales, incluidas las marcadas como
// muertas en docs/DATABASE.md — un backup es una foto completa, no un
// recorte a lo que la app usa hoy) — la mayoría dentro de una transacción de
// solo-lectura, así el dump no mezcla el estado de una tabla con escrituras
// concurrentes de otra mientras está en progreso (ver excepción arriba para
// las dos tablas con imágenes). Separada de buildBackupSql (armado del texto
// SQL) para que runBackupNow pueda mandar las tablas ya leídas a un Web
// Worker en vez de armar el dump en el hilo de UI — ver backupWorkerClient.ts.
async function readBackupTables(): Promise<{ tables: DumpTable[]; indexes: DumpIndex[] }> {
  const heavyPlaceholders = BACKUP_TABLES_FUERA_DE_TRANSACCION.map((_, i) => `?${i + 1}`).join(", ");
  const heavyMetaResult = await client.execute({
    sql: `SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN (${heavyPlaceholders})`,
    args: BACKUP_TABLES_FUERA_DE_TRANSACCION,
  });
  const heavyMeta = new Map(
    (heavyMetaResult.rows as unknown as { name: string; sql: string }[]).map((r) => [r.name, r.sql]),
  );
  const heavyTables: DumpTable[] = [];
  for (const name of BACKUP_TABLES_FUERA_DE_TRANSACCION) {
    const createSql = heavyMeta.get(name);
    if (createSql) heavyTables.push(await readTableDump(client, name, createSql));
  }

  const tx = await client.transaction("read");
  try {
    const tablesResult = await tx.execute({
      sql: `SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN (${heavyPlaceholders}) ORDER BY name`,
      args: BACKUP_TABLES_FUERA_DE_TRANSACCION,
    });
    const tables: DumpTable[] = [];
    for (const row of tablesResult.rows as unknown as { name: string; sql: string }[]) {
      tables.push(await readTableDump(tx, row.name, row.sql));
    }

    // Índices creados aparte de la definición de la tabla (sql IS NOT NULL
    // excluye los índices automáticos de PRIMARY KEY/UNIQUE inline, que ya se
    // recrean solos con el CREATE TABLE) — sin esto, restaurar un backup
    // pierde cualquier índice único/de rendimiento agregado por separado.
    const indexesResult = await tx.execute(
      "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND tbl_name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const indexes: DumpIndex[] = (
      indexesResult.rows as unknown as { name: string; tbl_name: string; sql: string }[]
    ).map((row) => ({ name: row.name, tableName: row.tbl_name, createSql: row.sql }));

    await tx.commit();
    return { tables: [...tables, ...heavyTables], indexes };
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}

/** Arma el dump SQL completo en el hilo actual — usada solo por los tests de integridad (corren en Node, no en el webview). `runBackupNow` (el camino real de la app) no la usa: arma el dump en un Web Worker en vez del hilo de UI — ver buildBackupArchive. */
export async function createBackupSql(): Promise<{ sql: string; manifest: import("./types").BackupManifest }> {
  const { tables, indexes } = await readBackupTables();
  return buildBackupSql(tables, indexes);
}

/**
 * Ejecuta un dump de restauración contra la BD en vivo. El PRAGMA/BEGIN/COMMIT
 * del propio texto del dump se descarta — client.migrate() maneja la
 * transacción de forma atómica vía el driver, con PRAGMA foreign_keys=off
 * antes del BEGIN y foreign_keys=on después del COMMIT (fuera de la
 * transacción, donde SQLite sí lo respeta — dentro es un no-op). Con
 * client.batch() normal el PRAGMA del propio dump quedaba dentro del BEGIN
 * implícito del driver y no tenía efecto, rompiendo la restauración en
 * cualquier tabla cuyo orden alfabético no respetara sus foreign keys.
 */
export async function executeRestoreSql(actor: Actor, sql: string): Promise<void> {
  await assertActorAuthorized(actor, "backups_restaurar");
  const statements = extractRestoreStatements(sql);

  // Subconjunto seguro: solo DROP TABLE IF EXISTS / CREATE TABLE / INSERT
  // INTO sobre una tabla que ya existe en la BD en vivo — un archivo
  // "backup" manipulado (statement arbitrario, tabla desconocida) se
  // rechaza aquí, antes de ejecutar nada. Ver validateRestoreStatements en
  // backup.ts.
  const tablesResult = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  );
  const knownTables = (tablesResult.rows as unknown as { name: string }[]).map((r) => r.name);
  const validation = validateRestoreStatements(statements, knownTables);
  if (!validation.ok) {
    throw new Error(`Archivo de restauración rechazado: ${validation.errors.join(" | ")}`);
  }

  await client.migrate(statements);
}

/** Conteos reales post-restauración contra los del manifiesto del backup usado — verificación real, no solo "el proceso terminó". */
export async function verifyRestoreCounts(
  expectedManifest: import("./types").BackupManifest,
): Promise<{ ok: boolean; mismatches: string[] }> {
  const mismatches: string[] = [];
  for (const [table, expected] of Object.entries(expectedManifest.tablas)) {
    try {
      const r = await client.execute(`SELECT COUNT(*) as n FROM ${table}`);
      const actual = Number((r.rows[0] as unknown as { n: number }).n);
      if (actual !== expected) mismatches.push(`${table}: esperado ${expected}, encontrado ${actual}`);
    } catch (err) {
      mismatches.push(`${table}: no se pudo verificar (${String(err)})`);
    }
  }
  if (expectedManifest.indices !== undefined && expectedManifest.indices.length > 0) {
    try {
      const r = await client.execute("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL");
      const actualNames = new Set((r.rows as unknown as { name: string }[]).map((row) => row.name));
      for (const idxName of expectedManifest.indices) {
        if (!actualNames.has(idxName)) mismatches.push(`índice ${idxName}: no encontrado tras la restauración`);
      }
    } catch (err) {
      mismatches.push(`índices: no se pudieron verificar (${String(err)})`);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

export const MAX_RESTORE_FILE_BYTES = 200 * 1024 * 1024;

export interface PickedFile {
  name: string;
  data: Uint8Array;
}

export async function pickBackupFile(): Promise<PickedFile | null> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "Backup de Clio", extensions: ["gz", "sql"] }],
  });
  if (!selected || Array.isArray(selected)) return null;
  await allowFsPath(selected);
  const data = await readFile(selected);
  const name = selected.split(/[/\\]/).pop() ?? selected;
  return { name, data };
}

export interface RunBackupResult {
  ok: boolean;
  record: BackupRecord;
  errors: string[];
}

/**
 * Orquesta un backup completo (dump → verificar → guardar local → registrar)
 * — usado tanto por "Crear backup ahora" como por el hook obligatorio antes
 * de capturas masivas y antes de restaurar. Un solo lugar, no triplicado por
 * cada llamador.
 */
export async function runBackupNow(
  tipo: BackupTipo,
  origen: string,
  usuario: string | null,
): Promise<RunBackupResult> {
  const record = await createBackupRecord({
    tipo,
    origen,
    usuario,
    archivo: "",
    ubicacion: "",
    estado: "EN_PROCESO",
  });
  try {
    const { tables, indexes } = await readBackupTables();
    const fileName = backupFileName();
    const { gz, checksum, validation } = await buildBackupArchive(tables, indexes);
    const path = await saveLocalBackupFile(fileName, gz);
    await client.execute({
      sql: "UPDATE backup_history SET archivo = ?1, ubicacion = ?2 WHERE id = ?3",
      args: [fileName, path, record.id],
    });
    const estado: BackupEstado = validation.ok ? "EXITOSO" : "FALLIDO";
    const detalle = validation.ok ? "" : validation.errors.join("; ");
    await updateBackupRecord(record.id, {
      estado,
      tamano_bytes: gz.length,
      checksum_sha256: checksum,
      detalle,
    });
    await logEvent(
      validation.ok ? "INFO" : "ERROR",
      `Backup ${tipo} (${origen}): ${validation.ok ? "exitoso" : `falló verificación — ${detalle}`} — ${fileName}`,
      usuario,
    );
    return {
      ok: validation.ok,
      record: { ...record, estado, archivo: fileName, ubicacion: path, tamano_bytes: gz.length, checksum_sha256: checksum, detalle },
      errors: validation.errors,
    };
  } catch (err) {
    const detalle = `No se pudo crear el backup: ${String(err)}`;
    await updateBackupRecord(record.id, { estado: "FALLIDO", detalle });
    await logEvent("ERROR", `Backup ${tipo} (${origen}) falló: ${String(err)}`, usuario);
    return { ok: false, record: { ...record, estado: "FALLIDO", detalle }, errors: [detalle] };
  }
}

interface BackupRecordRow {
  id: number;
  tipo: string;
  origen: string;
  usuario: string | null;
  archivo: string;
  ubicacion: string;
  tamano_bytes: number;
  checksum_sha256: string;
  estado: string;
  detalle: string;
  creado_en: string;
}

function rowToBackupRecord(row: BackupRecordRow): BackupRecord {
  return { ...row, tipo: row.tipo as BackupTipo, estado: row.estado as BackupEstado };
}

// No exportada a propósito: exportarla permitiría fabricar/alterar filas de
// backup_history (marcar un backup como OK sin que haya corrido) llamándola
// directo desde afuera con cualquier Actor o ninguno. La usan runBackupNow()
// (automático, sin Actor, dentro de este archivo) y recordRestoreResult()/
// recordBackupSettingsChange() abajo (con Actor y el permiso ya verificado).
async function createBackupRecord(input: {
  tipo: BackupTipo;
  origen: string;
  usuario: string | null;
  archivo: string;
  ubicacion: string;
  estado: BackupEstado;
  tamano_bytes?: number;
  checksum_sha256?: string;
  detalle?: string;
}): Promise<BackupRecord> {
  const result = await client.execute({
    sql: `INSERT INTO backup_history
            (tipo, origen, usuario, archivo, ubicacion, tamano_bytes, checksum_sha256, estado, detalle)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
          RETURNING *`,
    args: [
      input.tipo,
      input.origen,
      input.usuario,
      input.archivo,
      input.ubicacion,
      input.tamano_bytes ?? 0,
      input.checksum_sha256 ?? "",
      input.estado,
      input.detalle ?? "",
    ],
  });
  return rowToBackupRecord(result.rows[0] as unknown as BackupRecordRow);
}

// No exportada a propósito — ver createBackupRecord arriba.
async function updateBackupRecord(
  id: number,
  update: { estado: BackupEstado; tamano_bytes?: number; checksum_sha256?: string; detalle?: string },
): Promise<void> {
  await client.execute({
    sql: `UPDATE backup_history
          SET estado = ?1, tamano_bytes = COALESCE(?2, tamano_bytes), checksum_sha256 = COALESCE(?3, checksum_sha256), detalle = ?4
          WHERE id = ?5`,
    args: [update.estado, update.tamano_bytes ?? null, update.checksum_sha256 ?? null, update.detalle ?? "", id],
  });
}

// Variante de assertActorAuthorized que NO exige que session_token siga
// coincidiendo — solo que el id corresponda a un usuario activo con el
// permiso (o admin), tal como está la fila AHORA. Usada exclusivamente como
// fallback en recordRestoreResult: sigue rechazando a cualquiera que
// genuinamente no tenga el permiso (por id, no solo por token), así que no
// es un bypass de autorización — solo no exige que el token en memoria del
// llamador siga siendo el vigente.
async function assertUserHasPermissionById(userId: number, requiredPermiso: Permiso): Promise<void> {
  const result = await client.execute({
    sql: "SELECT rol, activo FROM users WHERE id = ?1",
    args: [userId],
  });
  const row = result.rows[0] as unknown as { rol: string; activo: number } | undefined;
  if (!row || !row.activo) {
    throw new Error("No autorizado: la sesión no es válida o venció.");
  }
  if (row.rol === "admin") return;
  const permResult = await client.execute({
    sql: "SELECT 1 FROM user_permissions WHERE user_id = ?1 AND permiso = ?2",
    args: [userId, requiredPermiso],
  });
  if (permResult.rows.length === 0) {
    throw new Error("No autorizado: falta el permiso requerido para esta acción.");
  }
}

// Registra en backup_history el resultado de una restauración — separada de
// createBackupRecord (privada) porque este flujo sí tiene un Actor real
// detrás y debe exigir el mismo permiso que ya validó executeRestoreSql un
// paso antes (backups_restaurar), para que esta fila no se pueda fabricar/
// alterar llamando la función directamente sin pasar por ahí.
//
// Se llama DESPUÉS de que la restauración ya ocurrió — y una restauración
// sobrescribe la tabla users completa, incluida la fila de este mismo actor,
// así que su session_token puede dejar de coincidir con el que se capturó
// antes de restaurar. Si la validación estricta (id + token) falla, se
// revalida el mismo permiso solo por id (assertUserHasPermissionById) antes
// de aceptar fallbackUsername — así un token vuelto stale por la propia
// restauración no impide registrar la auditoría, pero alguien que
// genuinamente nunca tuvo el permiso sigue siendo rechazado en ambos
// intentos, igual que antes.
export async function recordRestoreResult(
  actor: Actor,
  fallbackUsername: string,
  input: {
    tipo: Extract<BackupTipo, "RESTAURACION" | "RESTAURACION_ARCHIVO_SUBIDO">;
    origen: string;
    archivo: string;
    estado: BackupEstado;
    detalle?: string;
  },
): Promise<BackupRecord> {
  let username: string;
  try {
    username = await assertActorAuthorized(actor, "backups_restaurar");
  } catch {
    await assertUserHasPermissionById(actor.id, "backups_restaurar");
    username = fallbackUsername;
  }
  return createBackupRecord({ ...input, usuario: username, ubicacion: "-" });
}

// Registra en backup_history el cambio de programación — mismo motivo que
// recordRestoreResult, exige el permiso que ya validó updateBackupSettings.
export async function recordBackupSettingsChange(actor: Actor, detalle: string): Promise<BackupRecord> {
  const username = await assertActorAuthorized(actor, "backups_configurar");
  return createBackupRecord({
    tipo: "CONFIGURACION_CAMBIADA",
    origen: "Programación de backups",
    usuario: username,
    archivo: "-",
    ubicacion: "-",
    estado: "EXITOSO",
    detalle,
  });
}

export async function listBackupHistory(actor: Actor, limit = 100): Promise<BackupRecord[]> {
  await assertActorAuthorized(actor, "backups_ver");
  const result = await client.execute({
    sql: "SELECT * FROM backup_history ORDER BY creado_en DESC, id DESC LIMIT ?1",
    args: [limit],
  });
  return (result.rows as unknown as BackupRecordRow[]).map(rowToBackupRecord);
}

export async function deleteBackupRecord(actor: Actor, id: number): Promise<void> {
  await assertActorAuthorized(actor, "backups_eliminar");
  const result = await client.execute({
    sql: "SELECT * FROM backup_history WHERE id = ?1",
    args: [id],
  });
  const row = result.rows[0] as unknown as BackupRecordRow | undefined;
  if (row && !row.ubicacion.startsWith("http")) {
    await deleteLocalBackupFile(row.ubicacion);
  }
  await client.execute({ sql: "DELETE FROM backup_history WHERE id = ?1", args: [id] });
}

export async function getLatestBackup(estado?: BackupEstado): Promise<BackupRecord | null> {
  const result = estado
    ? await client.execute({
        sql: "SELECT * FROM backup_history WHERE estado = ?1 ORDER BY creado_en DESC, id DESC LIMIT 1",
        args: [estado],
      })
    : await client.execute("SELECT * FROM backup_history ORDER BY creado_en DESC, id DESC LIMIT 1");
  const row = result.rows[0] as unknown as BackupRecordRow | undefined;
  return row ? rowToBackupRecord(row) : null;
}

interface BackupSettingsRow {
  automatico_activado: number;
  frecuencia: string;
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

function rowToBackupSettings(row: BackupSettingsRow): BackupSettings {
  return {
    automatico_activado: Boolean(row.automatico_activado),
    frecuencia: row.frecuencia as BackupFrecuencia,
    hora_ejecucion: row.hora_ejecucion,
    intervalo_horas: row.intervalo_horas,
    dia_semana: row.dia_semana,
    retencion_diaria_dias: row.retencion_diaria_dias,
    retencion_semanal_dias: row.retencion_semanal_dias,
    retencion_mensual_dias: row.retencion_mensual_dias,
    ultimo_automatico_en: row.ultimo_automatico_en,
    actualizado_en: row.actualizado_en,
    actualizado_por: row.actualizado_por,
  };
}

export async function getBackupSettings(actor: Actor): Promise<BackupSettings> {
  await assertActorAuthorized(actor, "backups_ver");
  const result = await client.execute("SELECT * FROM backup_settings WHERE id = 1");
  return rowToBackupSettings(result.rows[0] as unknown as BackupSettingsRow);
}

/**
 * Carpeta local de backups disparados desde la propia app (manual,
 * pre-importación, pre-restauración) — bajo el directorio de datos de la
 * app, cubierto por fs:allow-appdata-*-recursive en capabilities, sin pedir
 * un permiso nuevo ni forzar rebuild.
 */
export async function getBackupsDir(): Promise<string> {
  const dir = await join(await appDataDir(), "backups");
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

function hasParentTraversal(path: string): boolean {
  return path.split(/[/\\]/).includes("..");
}

// fileName llega de backup_history.archivo — un valor que en teoría solo
// escribe la propia app, pero una fila manipulada a mano (o corrupta) no
// debe poder escapar la carpeta de backups vía "../../..." en el nombre.
function assertBareFileName(fileName: string): void {
  if (!fileName || /[/\\]/.test(fileName) || hasParentTraversal(fileName)) {
    throw new Error(`Nombre de archivo de backup inválido: "${fileName}".`);
  }
}

// path llega de backup_history.ubicacion (ruta absoluta completa) — mismo
// motivo: no debe poder resolver fuera de appDataDir()/backups.
async function assertWithinBackupsDir(path: string): Promise<void> {
  if (hasParentTraversal(path)) {
    throw new Error(`Ruta de backup inválida: "${path}".`);
  }
  const dir = (await getBackupsDir()).replace(/\\/g, "/").replace(/\/$/, "");
  const normalized = path.replace(/\\/g, "/");
  if (normalized !== dir && !normalized.startsWith(`${dir}/`)) {
    throw new Error(`Ruta fuera del directorio de backups: "${path}".`);
  }
}

export async function saveLocalBackupFile(fileName: string, bytes: Uint8Array): Promise<string> {
  assertBareFileName(fileName);
  const dir = await getBackupsDir();
  const path = await join(dir, fileName);
  await writeFile(path, bytes);
  return path;
}

export async function readLocalBackupFile(path: string): Promise<Uint8Array> {
  await assertWithinBackupsDir(path);
  return readFile(path);
}

export async function localBackupFileExists(path: string): Promise<boolean> {
  try {
    await assertWithinBackupsDir(path);
    return await exists(path);
  } catch {
    return false;
  }
}

export async function deleteLocalBackupFile(path: string): Promise<void> {
  await assertWithinBackupsDir(path);
  if (await localBackupFileExists(path)) {
    await remove(path);
  }
}

export async function saveBackupFileAs(defaultFileName: string, bytes: Uint8Array): Promise<boolean> {
  const target = await save({ defaultPath: defaultFileName });
  if (!target) return false;
  await allowFsPath(target);
  await writeFile(target, bytes);
  return true;
}

export async function updateBackupSettings(
  actor: Actor,
  settings: Pick<
    BackupSettings,
    | "automatico_activado"
    | "frecuencia"
    | "hora_ejecucion"
    | "intervalo_horas"
    | "dia_semana"
    | "retencion_diaria_dias"
    | "retencion_semanal_dias"
    | "retencion_mensual_dias"
  >,
): Promise<void> {
  const username = await assertActorAuthorized(actor, "backups_configurar");
  await client.execute({
    sql: `UPDATE backup_settings
          SET automatico_activado = ?1, frecuencia = ?2, hora_ejecucion = ?3, intervalo_horas = ?4,
              dia_semana = ?5, retencion_diaria_dias = ?6, retencion_semanal_dias = ?7,
              retencion_mensual_dias = ?8, actualizado_en = datetime('now'), actualizado_por = ?9
          WHERE id = 1`,
    args: [
      settings.automatico_activado ? 1 : 0,
      settings.frecuencia,
      settings.hora_ejecucion,
      settings.intervalo_horas,
      settings.dia_semana,
      settings.retencion_diaria_dias,
      settings.retencion_semanal_dias,
      settings.retencion_mensual_dias,
      username,
    ],
  });
}

// --- Precios ---

interface PrecioRow {
  id: number;
  sku: string;
  sku_principal: string;
  nombre: string;
  precio: number;
  actualizado_en: string;
  actualizado_por: string | null;
  creado_en: string;
  tipo: string | null;
}

function rowToPrecio(row: PrecioRow): Precio {
  return {
    id: row.id,
    sku: row.sku,
    sku_principal: row.sku_principal,
    nombre: row.nombre,
    precio: row.precio,
    actualizado_en: row.actualizado_en,
    actualizado_por: row.actualizado_por,
    creado_en: row.creado_en,
    tipo: row.tipo === "interno" || row.tipo === "externo" ? row.tipo : null,
  };
}

function assertPrecioValido(precio: number): void {
  if (!Number.isFinite(precio) || precio < 0) {
    throw new Error("Ingresa un precio válido (mayor o igual a 0).");
  }
}

export async function upsertPrecio(
  actor: Actor,
  input: PrecioInput & {
    // Solo la usa la captura masiva — preserva la fecha declarada en el
    // Excel en vez del momento real de importación (ver src/precios.ts). La
    // edición manual desde PreciosModal nunca la pasa.
    actualizadoEn?: string;
  },
): Promise<Precio> {
  // Se llama tanto desde PreciosModal (precios_modificar) como desde
  // "Guardar producto" en RemisionForm (solo remisiones_crear) — cualquiera
  // de los dos habilita la escritura, para no restringir el flujo existente
  // de Remisiones.
  const username = await assertActorAuthorized(actor, ["precios_modificar", "remisiones_crear"]);
  assertPrecioValido(input.precio);
  const skuPrincipal = computeSkuPrincipal(input.sku);

  const tx = await client.transaction("write");
  try {
    const existing = await tx.execute({
      sql: "SELECT precio FROM precios WHERE sku = ?1",
      args: [input.sku],
    });
    const precioAnterior =
      (existing.rows[0] as unknown as { precio: number } | undefined)?.precio ?? null;

    const result = await tx.execute({
      sql: `INSERT INTO precios (sku, sku_principal, nombre, precio, actualizado_en, actualizado_por, tipo)
            VALUES (?1, ?2, ?3, ?4, COALESCE(?5, datetime('now')), ?6, ?7)
            ON CONFLICT(sku) DO UPDATE SET
              sku_principal = ?2, nombre = ?3, precio = ?4,
              actualizado_en = COALESCE(?5, datetime('now')), actualizado_por = ?6,
              tipo = COALESCE(?7, precios.tipo)
            RETURNING *`,
      args: [
        input.sku,
        skuPrincipal,
        input.nombre,
        input.precio,
        input.actualizadoEn ?? null,
        username,
        input.tipo ?? null,
      ],
    });
    const row = result.rows[0] as unknown as PrecioRow;

    await tx.execute({
      sql: "INSERT INTO precios_historial (sku, precio_anterior, precio_nuevo, usuario) VALUES (?1, ?2, ?3, ?4)",
      args: [input.sku, precioAnterior, input.precio, username],
    });

    await tx.commit();
    return rowToPrecio(row);
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}

// Edita un precio existente permitiendo cambiar el SKU (identidad natural de
// la fila) — a diferencia de upsertPrecio, que solo puede crear/actualizar
// por SKU exacto y no puede "renombrarlo". Se identifica la fila por `id`
// (estable) en vez de por el SKU viejo, que es justo lo que está cambiando.
export async function updatePrecio(
  actor: Actor,
  id: number,
  input: PrecioInput,
): Promise<Precio> {
  const username = await assertActorAuthorized(actor, "precios_modificar");
  assertPrecioValido(input.precio);
  const skuPrincipal = computeSkuPrincipal(input.sku);

  const tx = await client.transaction("write");
  try {
    const conflict = await tx.execute({
      sql: "SELECT sku FROM precios WHERE sku = ?1 AND id != ?2",
      args: [input.sku, id],
    });
    if (conflict.rows.length > 0) {
      throw new Error(`El SKU ${input.sku} ya está en uso por otro producto.`);
    }

    const existing = await tx.execute({
      sql: "SELECT precio FROM precios WHERE id = ?1",
      args: [id],
    });
    const precioAnterior =
      (existing.rows[0] as unknown as { precio: number } | undefined)?.precio ?? null;

    const result = await tx.execute({
      sql: `UPDATE precios
            SET sku = ?1, sku_principal = ?2, nombre = ?3, precio = ?4,
                actualizado_en = datetime('now'), actualizado_por = ?5
            WHERE id = ?6
            RETURNING *`,
      args: [input.sku, skuPrincipal, input.nombre, input.precio, username, id],
    });
    const row = result.rows[0] as unknown as PrecioRow;

    await tx.execute({
      sql: "INSERT INTO precios_historial (sku, precio_anterior, precio_nuevo, usuario) VALUES (?1, ?2, ?3, ?4)",
      args: [input.sku, precioAnterior, input.precio, username],
    });

    await tx.commit();
    return rowToPrecio(row);
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}

// Permisos de las pantallas que hoy leen precios individuales/búsqueda:
// PreciosModal (precios_ver/precios_modificar), RemisionForm/
// RemisionDetalleModal (remisiones_acceso/remisiones_crear).
const PRECIO_LECTURA_PERMISOS: Permiso[] = [
  "precios_ver",
  "precios_modificar",
  "remisiones_acceso",
  "remisiones_crear",
];

export async function getPrecio(actor: Actor, sku: string): Promise<Precio | null> {
  await assertActorAuthorized(actor, PRECIO_LECTURA_PERMISOS);
  const result = await client.execute({
    sql: "SELECT * FROM precios WHERE sku = ?1",
    args: [sku],
  });
  const row = result.rows[0] as unknown as PrecioRow | undefined;
  return row ? rowToPrecio(row) : null;
}

export async function getPreciosBySkuPrincipal(actor: Actor, skuPrincipal: string): Promise<Precio[]> {
  await assertActorAuthorized(actor, PRECIO_LECTURA_PERMISOS);
  const result = await client.execute({
    sql: "SELECT * FROM precios WHERE sku_principal = ?1 ORDER BY sku",
    args: [skuPrincipal],
  });
  return (result.rows as unknown as PrecioRow[]).map(rowToPrecio);
}

export async function getPreciosList(actor: Actor): Promise<Precio[]> {
  await assertActorAuthorized(actor, ["precios_ver", "precios_modificar", "sku_master", "backups_ver"]);
  const result = await client.execute("SELECT * FROM precios ORDER BY sku");
  return (result.rows as unknown as PrecioRow[]).map(rowToPrecio);
}

// Búsqueda para el renglón de una remisión: el SKU (normal o con letra, ej.
// "7078E") y el nombre que se muestran ahí son los de `precios`, no los de
// `products` — un SKU con letra puede no tener ficha técnica propia.
export async function searchPrecios(actor: Actor, query: string): Promise<Precio[]> {
  await assertActorAuthorized(actor, PRECIO_LECTURA_PERMISOS);
  const trimmed = query.trim();
  if (!trimmed) return [];
  const result = await client.execute({
    sql: `SELECT * FROM precios WHERE ${foldSearchColumn("sku")} LIKE ?1 OR ${foldSearchColumn("nombre")} LIKE ?1 ORDER BY sku`,
    args: [`%${normalizeSearchTerm(trimmed)}%`],
  });
  return (result.rows as unknown as PrecioRow[]).map(rowToPrecio);
}

// --- Precios Venta (independiente de Precios Imprenta arriba — no se
// mezcla con `precios`/`precios_historial`, ver docs/DATABASE.md) ---

interface PrecioVentaRow {
  id: number;
  product_id: number;
  categoria: string;
  precio: number | null;
  actualizado_en: string;
  actualizado_por: string | null;
}

function assertCategoriaPrecioVentaValida(categoria: string): void {
  if (!(PRECIOS_VENTA_CATEGORIAS as readonly string[]).includes(categoria)) {
    throw new Error(`Categoría de Precios Venta inválida: "${categoria}".`);
  }
}

function assertPrecioVentaValido(precio: number | null): void {
  if (precio !== null && (!Number.isFinite(precio) || precio < 0)) {
    throw new Error("Ingresa un precio válido (mayor o igual a 0) o déjalo en blanco.");
  }
}

const PRECIO_VENTA_LECTURA_PERMISOS: Permiso[] = ["precios_venta_ver", "precios_venta_modificar"];

// Siempre devuelve las 5 categorías fijas, en el orden de
// PRECIOS_VENTA_CATEGORIAS, aunque el producto todavía no tenga ninguna fila
// en precios_venta (ficha nueva) — mismo criterio de normalización que
// getPrintItems con PROCESOS_IMPRENTA.
export async function getPreciosVenta(actor: Actor, productId: number): Promise<PrecioVenta[]> {
  await assertActorAuthorized(actor, PRECIO_VENTA_LECTURA_PERMISOS);
  const result = await client.execute({
    sql: "SELECT * FROM precios_venta WHERE product_id = ?1",
    args: [productId],
  });
  const rows = result.rows as unknown as PrecioVentaRow[];
  return PRECIOS_VENTA_CATEGORIAS.map((categoria) => {
    const row = rows.find((r) => r.categoria === categoria);
    return row
      ? {
          id: row.id,
          product_id: row.product_id,
          categoria,
          precio: row.precio,
          actualizado_en: row.actualizado_en,
          actualizado_por: row.actualizado_por,
        }
      : { id: null, product_id: productId, categoria, precio: null, actualizado_en: null, actualizado_por: null };
  });
}

// Guarda las 5 categorías como una sola unidad lógica (transacción) — no
// tiene sentido dejar 3 de 5 categorías guardadas si la cuarta falla la
// validación, así que primero se valida todo y recién después se escribe.
export async function savePreciosVenta(
  actor: Actor,
  productId: number,
  entradas: PrecioVentaEntradaInput[],
): Promise<PrecioVenta[]> {
  const username = await assertActorAuthorized(actor, "precios_venta_modificar");
  for (const entrada of entradas) {
    assertCategoriaPrecioVentaValida(entrada.categoria);
    assertPrecioVentaValido(entrada.precio);
  }

  const tx = await client.transaction("write");
  try {
    for (const entrada of entradas) {
      await tx.execute({
        sql: `INSERT INTO precios_venta (product_id, categoria, precio, actualizado_en, actualizado_por)
              VALUES (?1, ?2, ?3, datetime('now'), ?4)
              ON CONFLICT(product_id, categoria) DO UPDATE SET
                precio = ?3, actualizado_en = datetime('now'), actualizado_por = ?4`,
        args: [productId, entrada.categoria, entrada.precio, username],
      });
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
  return getPreciosVenta(actor, productId);
}

// --- Remisiones ---

interface RemisionRow {
  id: number;
  folio: string;
  fecha: string;
  tipo: string;
  pedido_bodegas: string | null;
  cancelada: number;
  subtotal: number;
  descuento_pct: number;
  descuento: number;
  iva: number;
  total: number;
  precio_texto: string;
  usuario: string | null;
  creado_en: string;
}

function rowToRemision(row: RemisionRow): Remision {
  return {
    id: row.id,
    folio: row.folio,
    fecha: row.fecha,
    tipo: row.tipo as TipoRemision,
    pedido_bodegas: row.pedido_bodegas ?? "",
    cancelada: !!row.cancelada,
    subtotal: row.subtotal,
    descuento_pct: row.descuento_pct,
    descuento: row.descuento,
    iva: row.iva,
    total: row.total,
    precio_texto: row.precio_texto,
    usuario: row.usuario,
    creado_en: row.creado_en,
  };
}

// Misma fórmula que RemisionForm.tsx/RemisionDetalleModal.tsx — recalculada
// server-side (en vez de confiar en precio_unitario/importe/subtotal/
// descuento/iva/total/precio_texto tal como los mande el cliente) para que
// llamar estas funciones directamente con esos campos manipulados no pueda
// dejar una remisión con números inconsistentes. Si se cambia el % de IVA o
// la fórmula de negocio, hay que actualizar los tres lugares a la vez.
export const IVA_RATE = 0.16;

// Aritmética pura, sin validar — comparte el mismo cálculo entre el servidor
// (computeRemisionTotales abajo, que sí valida/lanza) y la vista previa en
// vivo de RemisionForm.tsx/RemisionDetalleModal.tsx (que ya hace su propia
// validación por renglón para mostrar errores puntuales, y no quiere que un
// campo a medio teclear tire una excepción en cada render). Único lugar que
// conoce la fórmula de negocio: IVA = Subtotal × IVA_RATE; Total = Subtotal
// − Descuento + IVA (se suma — regla de negocio documentada en
// docs/WORKFLOWS.md).
export function computeRemisionMontos(
  renglones: { cantidad: number; precio_unitario: number }[],
  descuentoPct: number,
): { subtotal: number; descuento: number; iva: number; total: number } {
  const subtotal = renglones.reduce((sum, r) => sum + r.cantidad * r.precio_unitario, 0);
  const descuento = subtotal * (descuentoPct / 100);
  const iva = subtotal * IVA_RATE;
  const total = subtotal - descuento + iva;
  return { subtotal, descuento, iva, total };
}

function computeRemisionTotales(
  renglones: RemisionRenglonInput[],
  descuentoPct: number,
): {
  renglones: RemisionRenglonInput[];
  subtotal: number;
  descuento: number;
  iva: number;
  total: number;
  precioTexto: string;
} {
  if (renglones.length === 0) {
    throw new Error("Agrega al menos un producto.");
  }
  if (!Number.isFinite(descuentoPct) || descuentoPct < 0 || descuentoPct > 100) {
    throw new Error("El descuento % debe estar entre 0 y 100.");
  }
  const recomputed = renglones.map((r) => {
    if (!Number.isFinite(r.cantidad) || r.cantidad <= 0) {
      throw new Error(`Cantidad inválida en el renglón de ${r.sku || "producto sin SKU"}.`);
    }
    if (!Number.isFinite(r.precio_unitario) || r.precio_unitario < 0) {
      throw new Error(`Precio inválido en el renglón de ${r.sku || "producto sin SKU"}.`);
    }
    return { ...r, importe: r.cantidad * r.precio_unitario };
  });
  const { subtotal, descuento, iva, total } = computeRemisionMontos(recomputed, descuentoPct);
  if (total < 0) {
    throw new Error("El total no puede quedar negativo — revisa el descuento.");
  }
  return { renglones: recomputed, subtotal, descuento, iva, total, precioTexto: numeroATextoMoneda(total) };
}

// Folio + header + renglones en una sola transacción interactiva. Antes,
// RemisionForm llamaba a createFolio() por separado (confirmaba el folio de
// inmediato) y luego a createRemision(), que sí escribía header+renglones
// atómicamente vía client.batch() — pero si ese batch fallaba (ej. la
// conexión cae justo después), el folio ya consumido quedaba huérfano: un
// "documento fantasma" con folio quemado y ninguna remisión real. Ahora todo
// se confirma o se revierte junto, así que un fallo nunca deja un folio sin
// su remisión ni una remisión sin (todos) sus renglones.
// El segundo parámetro se llama `bodega` (no `sku`, a diferencia de
// createFolio/createRequisicionConFolio): a pedido del negocio, el folio de
// remisión lleva el nombre de la bodega destino en el segmento donde los
// otros tres tipos (Requisición/Producción/Compra) llevan el SKU del
// producto — RemisionForm le pasa `pedido_bodegas`, no un SKU.
export async function createRemisionConFolio(
  actor: Actor,
  bodega: string,
  input: Omit<RemisionInput, "folio" | "subtotal" | "descuento" | "iva" | "total" | "precio_texto" | "usuario">,
  renglones: RemisionRenglonInput[],
): Promise<RemisionConRenglones> {
  const username = await assertActorAuthorized(actor, "remisiones_crear");
  const totales = computeRemisionTotales(renglones, input.descuento_pct);
  const tx = await client.transaction("write");
  try {
    const folio = await insertFolioRow(tx, "remision", bodega);

    const headerResult = await tx.execute({
      sql: `INSERT INTO remisiones
              (folio, fecha, tipo, pedido_bodegas, subtotal, descuento_pct, descuento, iva, total, precio_texto, usuario)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            RETURNING *`,
      args: [
        folio.folio,
        input.fecha,
        input.tipo,
        input.pedido_bodegas,
        totales.subtotal,
        input.descuento_pct,
        totales.descuento,
        totales.iva,
        totales.total,
        totales.precioTexto,
        username,
      ],
    });
    const headerRow = headerResult.rows[0] as unknown as RemisionRow;

    const savedRenglones: RemisionRenglon[] = [];
    for (const [i, r] of totales.renglones.entries()) {
      const rowResult = await tx.execute({
        sql: `INSERT INTO remision_renglones
                (remision_id, numero_renglon, sku, producto_nombre, cantidad, precio_unitario, importe)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
              RETURNING *`,
        args: [headerRow.id, i + 1, r.sku, r.producto_nombre, r.cantidad, r.precio_unitario, r.importe],
      });
      savedRenglones.push(rowResult.rows[0] as unknown as RemisionRenglon);
    }

    await tx.commit();
    return { ...rowToRemision(headerRow), renglones: savedRenglones };
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}

// Edita una remisión existente conservando folio, fecha, tipo, usuario
// (creador) y creado_en — actualiza pedido_bodegas y los totales
// (recalculados a partir de los renglones editados) y reemplaza los
// renglones por completo (mismo patrón replace-and-reinsert que
// specs/descriptions), nunca genera un folio nuevo ni una segunda remisión.
export async function updateRemisionConRenglones(
  actor: Actor,
  id: number,
  totalesInput: Pick<RemisionInput, "pedido_bodegas" | "descuento_pct">,
  renglones: RemisionRenglonInput[],
): Promise<RemisionConRenglones> {
  await assertActorAuthorized(actor, "remisiones_crear");
  const totales = computeRemisionTotales(renglones, totalesInput.descuento_pct);
  const tx = await client.transaction("write");
  try {
    const headerResult = await tx.execute({
      sql: `UPDATE remisiones
              SET pedido_bodegas = ?1, subtotal = ?2, descuento_pct = ?3, descuento = ?4, iva = ?5,
                  total = ?6, precio_texto = ?7
            WHERE id = ?8
            RETURNING *`,
      args: [
        totalesInput.pedido_bodegas,
        totales.subtotal,
        totalesInput.descuento_pct,
        totales.descuento,
        totales.iva,
        totales.total,
        totales.precioTexto,
        id,
      ],
    });
    const headerRow = headerResult.rows[0] as unknown as RemisionRow | undefined;
    if (!headerRow) throw new Error("Remisión no encontrada.");

    await tx.execute({ sql: "DELETE FROM remision_renglones WHERE remision_id = ?1", args: [id] });

    const savedRenglones: RemisionRenglon[] = [];
    for (const [i, r] of totales.renglones.entries()) {
      const rowResult = await tx.execute({
        sql: `INSERT INTO remision_renglones
                (remision_id, numero_renglon, sku, producto_nombre, cantidad, precio_unitario, importe)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
              RETURNING *`,
        args: [id, i + 1, r.sku, r.producto_nombre, r.cantidad, r.precio_unitario, r.importe],
      });
      savedRenglones.push(rowResult.rows[0] as unknown as RemisionRenglon);
    }

    await tx.commit();
    return { ...rowToRemision(headerRow), renglones: savedRenglones };
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}

export async function listRemisiones(actor: Actor, limit = 30): Promise<Remision[]> {
  await assertActorAuthorized(actor, "remisiones_acceso");
  const result = await client.execute({
    sql: "SELECT * FROM remisiones ORDER BY id DESC LIMIT ?1",
    args: [limit],
  });
  return (result.rows as unknown as RemisionRow[]).map(rowToRemision);
}

export async function getRemisionRenglones(actor: Actor, remisionId: number): Promise<RemisionRenglon[]> {
  await assertActorAuthorized(actor, "remisiones_acceso");
  const result = await client.execute({
    sql: "SELECT * FROM remision_renglones WHERE remision_id = ?1 ORDER BY numero_renglon",
    args: [remisionId],
  });
  return result.rows as unknown as RemisionRenglon[];
}

// Mismo patrón que deletePrintItemOrder/deletePrintItemPurchase (Imprenta):
// borrado real, no un flag — remision_renglones se borra primero por la FK.
export async function deleteRemision(actor: Actor, id: number): Promise<void> {
  const username = await assertActorAuthorized(actor, "remisiones_cancelar");
  const tx = await client.transaction("write");
  try {
    await tx.execute({ sql: "DELETE FROM remision_renglones WHERE remision_id = ?1", args: [id] });
    await tx.execute({ sql: "DELETE FROM remisiones WHERE id = ?1", args: [id] });
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
  await logEvent("WARNING", `Remisión #${id} eliminada`, username);
}

// Sin chequeo de Actor a propósito — es un helper interno, cada exportado
// que la llama (listRemisionRenglonesParaHistorial, getSkuMasterExportData)
// hace su propio assertActorAuthorized con el permiso de su propia pantalla
// antes de invocarla, mismo criterio que el resto de queries de soporte.
async function fetchRemisionRenglonesHistorial(): Promise<RemisionHistorialRow[]> {
  const result = await client.execute(`
    SELECT
      r.fecha AS fecha, r.folio AS folio, r.pedido_bodegas AS pedido_bodegas, r.cancelada AS cancelada,
      rr.numero_renglon AS numero_renglon, rr.sku AS sku, rr.cantidad AS cantidad,
      rr.producto_nombre AS producto_nombre, rr.precio_unitario AS precio_unitario, rr.importe AS importe,
      r.subtotal AS subtotal, r.descuento_pct AS descuento_pct, r.descuento AS descuento, r.iva AS iva, r.total AS total
    FROM remision_renglones rr
    JOIN remisiones r ON r.id = rr.remision_id
    ORDER BY r.fecha, r.id, rr.numero_renglon
  `);
  return (
    result.rows as unknown as (Omit<RemisionHistorialRow, "pedido_bodegas" | "cancelada"> & {
      pedido_bodegas: string | null;
      cancelada: number;
    })[]
  ).map((row) => ({
    ...row,
    pedido_bodegas: row.pedido_bodegas ?? "",
    cancelada: !!row.cancelada,
  }));
}

export async function listRemisionRenglonesParaHistorial(actor: Actor): Promise<RemisionHistorialRow[]> {
  await assertActorAuthorized(actor, "backups_ver");
  return fetchRemisionRenglonesHistorial();
}

// --- Exportación completa de SKU Master (Objetivo: Excel con todo lo
// relacionado a cada SKU) ---

// Una fila por vínculo ficha↔pieza (product_plastic_items), vía LEFT JOIN
// desde plastic_products — así una pieza sin ninguna ficha vinculada también
// aparece (con producto_codigo/producto_nombre en null) en vez de perderse,
// y una pieza reutilizada en varias fichas aparece una vez por ficha. Sin
// columnas de imagen, mismo criterio que PLASTIC_PRODUCT_LIST_COLUMNS.
export interface PiezaDesgloseExportRow {
  producto_codigo: string | null;
  producto_nombre: string | null;
  orden: number | null;
  pieza_id: number;
  sku: string;
  nombre: string;
  descripcion: string;
  material: string;
  color: string;
  origen: string;
  dimension: string;
  peso: string;
  tipo_empaque: string;
  maquila: string;
  coste: string;
  componentes_fabricacion: string;
  dimensiones_empaque: string;
}

async function fetchPiezasDesgloseParaExport(): Promise<PiezaDesgloseExportRow[]> {
  const result = await client.execute(`
    SELECT
      p.codigo AS producto_codigo, p.nombre AS producto_nombre, ppi.orden AS orden,
      pp.id AS pieza_id, pp.sku AS sku, pp.nombre AS nombre, pp.descripcion AS descripcion,
      pp.armado AS material, pp.color AS color, pp.origen AS origen, pp.dimension AS dimension,
      pp.peso AS peso, pp.tipo_empaque AS tipo_empaque, pp.maquila AS maquila, pp.coste AS coste,
      pp.componentes_fabricacion AS componentes_fabricacion, pp.dimensiones_empaque AS dimensiones_empaque
    FROM plastic_products pp
    LEFT JOIN product_plastic_items ppi ON ppi.plastic_product_id = pp.id
    LEFT JOIN products p ON p.id = ppi.product_id
    ORDER BY (p.codigo IS NULL), p.codigo, pp.nombre
  `);
  return result.rows as unknown as PiezaDesgloseExportRow[];
}

export interface SkuMasterExportData {
  productos: Product[];
  piezas: PiezaDesgloseExportRow[];
  precios: Precio[];
  remisiones: RemisionHistorialRow[];
}

// Único punto de entrada para el export de SKU Master: un solo chequeo de
// permiso (sku_master, el mismo que ya gatea toda esa pantalla) y las 4
// consultas en paralelo, en vez de que el componente llame 4 funciones
// exportadas por separado (cada una repitiendo su propio assertActor).
export async function getSkuMasterExportData(actor: Actor): Promise<SkuMasterExportData> {
  await assertActorAuthorized(actor, "sku_master");
  const [productos, piezas, precios, remisiones] = await Promise.all([
    searchProducts(""),
    fetchPiezasDesgloseParaExport(),
    getPreciosList(actor),
    fetchRemisionRenglonesHistorial(),
  ]);
  return { productos, piezas, precios, remisiones };
}
