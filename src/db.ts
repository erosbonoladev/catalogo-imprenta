import { createClient, type Client, type Transaction } from "@libsql/client/web";
import { open, save } from "@tauri-apps/plugin-dialog";
import { exists, mkdir, readDir, readFile, remove, writeFile } from "@tauri-apps/plugin-fs";
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
} from "./types";
import { PROCESOS_IMPRENTA } from "./types";
import { buildRequisicionMessage } from "./requisiciones";
import { FOLIO_PREFIJOS, buildFolioString, fechaLocalDeHoy, formatFechaFolioLocal } from "./folios";
import { computeSkuPrincipal } from "./precios";
import {
  type DumpTable,
  backupFileName,
  buildBackupSql,
  extractRestoreStatements,
  gzipText,
  sha256Hex,
  validateBackupSql,
  validateRestoreStatements,
} from "./backup";

const client = createClient({
  url: import.meta.env.VITE_TURSO_URL,
  authToken: import.meta.env.VITE_TURSO_AUTH_TOKEN,
  intMode: "number",
});

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
    presentacion_original: row.presentacion_original ?? "",
    creado_en: row.creado_en,
    actualizado_en: row.actualizado_en ?? row.creado_en,
  };
}

const SEARCH_FILTER_CLAUSES: Record<SearchFilter, string> = {
  todo: "codigo LIKE ?1 OR nombre LIKE ?1 OR material LIKE ?1",
  nombre: "nombre LIKE ?1 OR descripcion LIKE ?1",
  sku: "codigo LIKE ?1",
  material: "material LIKE ?1",
};

export async function searchProducts(
  query: string,
  filter: SearchFilter = "todo",
): Promise<Product[]> {
  const trimmed = query.trim();
  const result = trimmed
    ? await client.execute({
        sql: `SELECT * FROM products WHERE ${SEARCH_FILTER_CLAUSES[filter]} ORDER BY nombre, material`,
        args: [`%${trimmed}%`],
      })
    : await client.execute(
        "SELECT * FROM products ORDER BY nombre, material",
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
  // Header + specs + descriptions en una sola transacción interactiva: antes
  // eran client.execute() sueltos, así que una falla a medias (ej. conexión
  // caída justo después del INSERT del producto) dejaba una ficha sin sus
  // specs — sobre todo relevante en Captura masiva, donde esto corre fila
  // tras fila sin supervisión.
  const tx = await client.transaction("write");
  try {
    const result = await tx.execute({
      sql: `INSERT INTO products (codigo, nombre, categoria, material, descripcion, imagen, imagen_mime, imagen_codigo_barras, imagen_codigo_barras_mime, actualizado_en)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))`,
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
  const tx = await client.transaction("write");
  try {
    await tx.execute({
      sql: `UPDATE products
            SET codigo = ?1, nombre = ?2, categoria = ?3, material = ?4, descripcion = ?5, imagen = ?6, imagen_mime = ?7,
                imagen_codigo_barras = ?8, imagen_codigo_barras_mime = ?9,
                actualizado_en = datetime('now')
            WHERE id = ?10`,
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

export async function setPresentacionOriginal(productId: number, text: string): Promise<void> {
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
export const MAX_EXCEL_IMPORT_FILE_BYTES = 25 * 1024 * 1024;

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

export async function updateProductImage(
  id: number,
  imagen: ImageBlob,
): Promise<void> {
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
  backup_local_diario: number;
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
    backup_local_diario: Boolean(row.backup_local_diario),
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
): Promise<{ rol: string; activo: number } | undefined> {
  const result = await client.execute({
    sql: `SELECT rol, activo FROM users
          WHERE id = ?1 AND session_token = ?2
            AND session_expires_at IS NOT NULL AND session_expires_at > datetime('now')`,
    args: [actor.id, actor.token],
  });
  return result.rows[0] as unknown as { rol: string; activo: number } | undefined;
}

// Para acciones que no tienen un permiso otorgable propio (ej. catálogo
// base, intencionalmente abierto a cualquier usuario autenticado — ver
// docs/PERMISSIONS.md): solo exige una sesión vigente y activa, sin rol ni
// permiso específico.
async function assertActorSession(actor: Actor): Promise<void> {
  const row = await loadActorSession(actor);
  if (!row || !row.activo) {
    throw new Error("No autorizado: la sesión no es válida o venció.");
  }
}

async function assertActorAuthorized(
  actor: Actor,
  requiredPermiso?: Permiso | Permiso[],
): Promise<void> {
  const row = await loadActorSession(actor);
  if (!row || !row.activo) {
    throw new Error("No autorizado: la sesión no es válida o venció.");
  }
  if (row.rol === "admin") return;
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
  const result = await client.execute({
    sql: `INSERT INTO users (username, password_hash, activo, rol, backup_local_diario) VALUES (?1, ?2, ?3, ?4, ?5)`,
    args: [input.username.trim(), hash, input.activo ? 1 : 0, input.rol, input.backup_local_diario ? 1 : 0],
  });
  const userId = Number(result.lastInsertRowid);
  await savePermissions(userId, input.permisos);
  return userId;
}

export async function updateUser(actor: Actor, id: number, input: UserInput): Promise<void> {
  await assertActorAuthorized(actor);
  if (input.password) {
    const hash = await invoke<string>("hash_password", { password: input.password });
    await client.execute({
      sql: `UPDATE users SET username = ?1, activo = ?2, rol = ?3, backup_local_diario = ?4, password_hash = ?5, session_token = NULL, session_expires_at = NULL WHERE id = ?6`,
      args: [input.username.trim(), input.activo ? 1 : 0, input.rol, input.backup_local_diario ? 1 : 0, hash, id],
    });
  } else {
    await client.execute({
      sql: `UPDATE users SET username = ?1, activo = ?2, rol = ?3, backup_local_diario = ?4 WHERE id = ?5`,
      args: [input.username.trim(), input.activo ? 1 : 0, input.rol, input.backup_local_diario ? 1 : 0, id],
    });
  }
  await savePermissions(id, input.permisos);
}

async function savePermissions(userId: number, permisos: Permiso[]): Promise<void> {
  await client.execute({
    sql: "DELETE FROM user_permissions WHERE user_id = ?1",
    args: [userId],
  });
  for (const permiso of permisos) {
    await client.execute({
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

export async function clearSession(userId: number): Promise<void> {
  await client.execute({
    sql: "DELETE FROM user_sessions WHERE user_id = ?1",
    args: [userId],
  });
  await client.execute({
    sql: "UPDATE users SET session_token = NULL, session_expires_at = NULL WHERE id = ?1",
    args: [userId],
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

export async function getRecentLogs(limit = 200): Promise<AppLog[]> {
  const result = await client.execute({
    sql: "SELECT * FROM app_logs ORDER BY id DESC LIMIT ?1",
    args: [limit],
  });
  return result.rows as unknown as AppLog[];
}

export async function clearLogs(): Promise<void> {
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
  await client.execute({
    sql: "DELETE FROM product_plastic_pieces WHERE product_id = ?1",
    args: [productId],
  });
  let orden = 1;
  for (const piece of pieces) {
    const sku = piece.sku.trim();
    if (!sku) continue;
    await client.execute({
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
              WHERE nombre LIKE ?1 OR sku LIKE ?1 OR color LIKE ?1
              ORDER BY nombre, sku`,
        args: [`%${trimmed}%`],
      })
    : await client.execute("SELECT * FROM plastic_products ORDER BY nombre, sku");
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
): Promise<number> {
  await assertActorAuthorized(actor, "plasticos");
  const result = await client.execute({
    sql: `INSERT INTO plastic_products
          (nombre, sku, color, origen, descripcion, armado, dimension, peso, tipo_empaque, maquila, coste, imagen, imagen_mime)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
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
): Promise<void> {
  await assertActorAuthorized(actor, "plasticos");
  await client.execute({
    sql: `UPDATE plastic_products
          SET nombre = ?1, sku = ?2, color = ?3, origen = ?4, descripcion = ?5, armado = ?6,
              dimension = ?7, peso = ?8, tipo_empaque = ?9, maquila = ?10, coste = ?11,
              imagen = ?12, imagen_mime = ?13
          WHERE id = ?14`,
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
      input.imagen?.data ?? null,
      input.imagen?.mime ?? null,
      id,
    ],
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
  const resolved: { plasticProductId: number; orden: number }[] = [];
  let orden = 1;
  for (const item of items) {
    if (!item.data.nombre.trim() && !item.data.sku.trim()) continue;
    let plasticProductId: number;
    if (item.plastic_product_id) {
      plasticProductId = item.plastic_product_id;
      await updatePlasticProduct(actor, plasticProductId, item.data);
    } else {
      plasticProductId = await createPlasticProduct(actor, item.data);
    }
    resolved.push({ plasticProductId, orden });
    orden += 1;
  }
  await client.execute({
    sql: "DELETE FROM product_plastic_items WHERE product_id = ?1",
    args: [productId],
  });
  for (const { plasticProductId, orden: itemOrden } of resolved) {
    await client.execute({
      sql: `INSERT INTO product_plastic_items (product_id, plastic_product_id, orden) VALUES (?1, ?2, ?3)`,
      args: [productId, plasticProductId, itemOrden],
    });
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
  const items: PrintItem[] = [];
  for (const row of result.rows as unknown as PrintItemRow[]) {
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
    items.push({
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
    });
  }
  return items;
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
      await client.execute({
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
      const result = await client.execute({
        sql: `INSERT INTO product_print_items (
                nombre, tamano, tipo_papel, tintas, gramos_puntos, pliego, extendido, corte_cm,
                maquina, formacion, numero_pliegos, acabados, notas, numero_placas,
                placas_existentes, orden, product_id
              ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)`,
        args: [...values, productId],
      });
      printItemId = Number(result.lastInsertRowid);
    }

    await client.execute({
      sql: "DELETE FROM product_print_item_checks WHERE print_item_id = ?1",
      args: [printItemId],
    });
    let checkOrden = 1;
    for (const check of item.checks) {
      await client.execute({
        sql: `INSERT INTO product_print_item_checks (print_item_id, nombre, marcado, orden)
              VALUES (?1, ?2, ?3, ?4)`,
        args: [printItemId, check.nombre.trim(), check.marcado ? 1 : 0, checkOrden],
      });
      checkOrden += 1;
    }
    await client.execute({
      sql: "DELETE FROM product_print_item_extras WHERE print_item_id = ?1",
      args: [printItemId],
    });
    let extraOrden = 1;
    for (const extra of item.extras) {
      const etiqueta = extra.etiqueta.trim();
      const valor = extra.valor.trim();
      if (!etiqueta || !valor) continue;
      await client.execute({
        sql: `INSERT INTO product_print_item_extras (print_item_id, etiqueta, valor, orden)
              VALUES (?1, ?2, ?3, ?4)`,
        args: [printItemId, etiqueta, valor, extraOrden],
      });
      extraOrden += 1;
    }

    await client.execute({
      sql: "DELETE FROM product_print_item_images WHERE print_item_id = ?1",
      args: [printItemId],
    });
    let imageOrden = 1;
    for (const image of item.images) {
      await client.execute({
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
    await client.execute({
      sql: "DELETE FROM product_print_item_checks WHERE print_item_id=?1",
      args: [id],
    });
    await client.execute({
      sql: "DELETE FROM product_print_item_extras WHERE print_item_id=?1",
      args: [id],
    });
    await client.execute({
      sql: "DELETE FROM product_print_item_images WHERE print_item_id=?1",
      args: [id],
    });
    await client.execute({
      sql: `DELETE FROM product_print_item_purchases WHERE print_item_order_id IN
            (SELECT id FROM product_print_item_orders WHERE print_item_id = ?1)`,
      args: [id],
    });
    await client.execute({
      sql: "DELETE FROM product_print_item_orders WHERE print_item_id=?1",
      args: [id],
    });
    await client.execute({
      sql: "DELETE FROM product_print_items WHERE id=?1",
      args: [id],
    });
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
  usuario?: string | null,
): Promise<PrintItemOrder> {
  await assertActorAuthorized(actor, "imprenta");
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
      usuario ?? null,
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
    usuario: usuario ?? null,
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
  usuario?: string | null,
): Promise<PrintItemPurchase> {
  await assertActorAuthorized(actor, "imprenta");
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
      usuario ?? null,
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
    usuario: usuario ?? null,
    folio: input.folio,
    creado_en: new Date().toISOString(),
  };
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
  input: RequisicionInput,
): Promise<Requisicion> {
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
      input.usuario,
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
  sku: string,
  input: Omit<RequisicionInput, "folio">,
): Promise<Requisicion> {
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
        input.usuario,
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

/**
 * Lee toda la BD (todas las tablas reales, incluidas las marcadas como
 * muertas en docs/DATABASE.md — un backup es una foto completa, no un
 * recorte a lo que la app usa hoy) y arma el dump SQL. Usado tanto por el
 * botón "Crear backup ahora" como por el hook previo a importaciones.
 */
export async function createBackupSql(): Promise<{ sql: string; manifest: import("./types").BackupManifest }> {
  const tablesResult = await client.execute(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const tables: DumpTable[] = [];
  for (const row of tablesResult.rows as unknown as { name: string; sql: string }[]) {
    const columnsResult = await client.execute(`PRAGMA table_info(${row.name})`);
    const columns = (columnsResult.rows as unknown as { name: string }[]).map((c) => c.name);
    const rowsResult = await client.execute(`SELECT * FROM ${row.name}`);
    tables.push({
      name: row.name,
      createSql: row.sql,
      columns,
      rows: rowsResult.rows as unknown as Record<string, unknown>[],
    });
  }
  return buildBackupSql(tables);
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
    const { sql } = await createBackupSql();
    const validation = validateBackupSql(sql);
    const fileName = backupFileName();
    const gz = await gzipText(sql);
    const checksum = await sha256Hex(sql);
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

export async function createBackupRecord(input: {
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

export async function updateBackupRecord(
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

export async function listBackupHistory(limit = 100): Promise<BackupRecord[]> {
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

export async function getBackupSettings(): Promise<BackupSettings> {
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
  usuario: string | null,
): Promise<void> {
  await assertActorAuthorized(actor, "backups_configurar");
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
      usuario,
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
  await assertActorAuthorized(actor, ["precios_modificar", "remisiones_crear"]);
  const skuPrincipal = computeSkuPrincipal(input.sku);
  const existing = await client.execute({
    sql: "SELECT precio FROM precios WHERE sku = ?1",
    args: [input.sku],
  });
  const precioAnterior =
    (existing.rows[0] as unknown as { precio: number } | undefined)?.precio ?? null;

  const result = await client.execute({
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
      input.usuario,
      input.tipo ?? null,
    ],
  });
  const row = result.rows[0] as unknown as PrecioRow;

  await client.execute({
    sql: "INSERT INTO precios_historial (sku, precio_anterior, precio_nuevo, usuario) VALUES (?1, ?2, ?3, ?4)",
    args: [input.sku, precioAnterior, input.precio, input.usuario],
  });

  return rowToPrecio(row);
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
  await assertActorAuthorized(actor, "precios_modificar");
  const skuPrincipal = computeSkuPrincipal(input.sku);

  const conflict = await client.execute({
    sql: "SELECT sku FROM precios WHERE sku = ?1 AND id != ?2",
    args: [input.sku, id],
  });
  if (conflict.rows.length > 0) {
    throw new Error(`El SKU ${input.sku} ya está en uso por otro producto.`);
  }

  const existing = await client.execute({
    sql: "SELECT precio FROM precios WHERE id = ?1",
    args: [id],
  });
  const precioAnterior =
    (existing.rows[0] as unknown as { precio: number } | undefined)?.precio ?? null;

  const result = await client.execute({
    sql: `UPDATE precios
          SET sku = ?1, sku_principal = ?2, nombre = ?3, precio = ?4,
              actualizado_en = datetime('now'), actualizado_por = ?5
          WHERE id = ?6
          RETURNING *`,
    args: [input.sku, skuPrincipal, input.nombre, input.precio, input.usuario, id],
  });
  const row = result.rows[0] as unknown as PrecioRow;

  await client.execute({
    sql: "INSERT INTO precios_historial (sku, precio_anterior, precio_nuevo, usuario) VALUES (?1, ?2, ?3, ?4)",
    args: [input.sku, precioAnterior, input.precio, input.usuario],
  });

  return rowToPrecio(row);
}

export async function getPrecio(sku: string): Promise<Precio | null> {
  const result = await client.execute({
    sql: "SELECT * FROM precios WHERE sku = ?1",
    args: [sku],
  });
  const row = result.rows[0] as unknown as PrecioRow | undefined;
  return row ? rowToPrecio(row) : null;
}

export async function getPreciosBySkuPrincipal(skuPrincipal: string): Promise<Precio[]> {
  const result = await client.execute({
    sql: "SELECT * FROM precios WHERE sku_principal = ?1 ORDER BY sku",
    args: [skuPrincipal],
  });
  return (result.rows as unknown as PrecioRow[]).map(rowToPrecio);
}

export async function getPreciosList(): Promise<Precio[]> {
  const result = await client.execute("SELECT * FROM precios ORDER BY sku");
  return (result.rows as unknown as PrecioRow[]).map(rowToPrecio);
}

// Búsqueda para el renglón de una remisión: el SKU (normal o con letra, ej.
// "7078E") y el nombre que se muestran ahí son los de `precios`, no los de
// `products` — un SKU con letra puede no tener ficha técnica propia.
export async function searchPrecios(query: string): Promise<Precio[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const result = await client.execute({
    sql: "SELECT * FROM precios WHERE sku LIKE ?1 OR nombre LIKE ?1 ORDER BY sku",
    args: [`%${trimmed}%`],
  });
  return (result.rows as unknown as PrecioRow[]).map(rowToPrecio);
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

// Folio + header + renglones en una sola transacción interactiva. Antes,
// RemisionForm llamaba a createFolio() por separado (confirmaba el folio de
// inmediato) y luego a createRemision(), que sí escribía header+renglones
// atómicamente vía client.batch() — pero si ese batch fallaba (ej. la
// conexión cae justo después), el folio ya consumido quedaba huérfano: un
// "documento fantasma" con folio quemado y ninguna remisión real. Ahora todo
// se confirma o se revierte junto, así que un fallo nunca deja un folio sin
// su remisión ni una remisión sin (todos) sus renglones.
export async function createRemisionConFolio(
  actor: Actor,
  sku: string,
  input: Omit<RemisionInput, "folio">,
  renglones: RemisionRenglonInput[],
): Promise<RemisionConRenglones> {
  await assertActorAuthorized(actor, "remisiones_crear");
  const tx = await client.transaction("write");
  try {
    const folio = await insertFolioRow(tx, "remision", sku);

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
        input.subtotal,
        input.descuento_pct,
        input.descuento,
        input.iva,
        input.total,
        input.precio_texto,
        input.usuario,
      ],
    });
    const headerRow = headerResult.rows[0] as unknown as RemisionRow;

    const savedRenglones: RemisionRenglon[] = [];
    for (const [i, r] of renglones.entries()) {
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
  totales: Pick<
    RemisionInput,
    "pedido_bodegas" | "subtotal" | "descuento_pct" | "descuento" | "iva" | "total" | "precio_texto"
  >,
  renglones: RemisionRenglonInput[],
): Promise<RemisionConRenglones> {
  await assertActorAuthorized(actor, "remisiones_crear");
  const tx = await client.transaction("write");
  try {
    const headerResult = await tx.execute({
      sql: `UPDATE remisiones
              SET pedido_bodegas = ?1, subtotal = ?2, descuento_pct = ?3, descuento = ?4, iva = ?5,
                  total = ?6, precio_texto = ?7
            WHERE id = ?8
            RETURNING *`,
      args: [
        totales.pedido_bodegas,
        totales.subtotal,
        totales.descuento_pct,
        totales.descuento,
        totales.iva,
        totales.total,
        totales.precio_texto,
        id,
      ],
    });
    const headerRow = headerResult.rows[0] as unknown as RemisionRow | undefined;
    if (!headerRow) throw new Error("Remisión no encontrada.");

    await tx.execute({ sql: "DELETE FROM remision_renglones WHERE remision_id = ?1", args: [id] });

    const savedRenglones: RemisionRenglon[] = [];
    for (const [i, r] of renglones.entries()) {
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

export async function listRemisiones(limit = 30): Promise<Remision[]> {
  const result = await client.execute({
    sql: "SELECT * FROM remisiones ORDER BY id DESC LIMIT ?1",
    args: [limit],
  });
  return (result.rows as unknown as RemisionRow[]).map(rowToRemision);
}

export async function getRemisionRenglones(remisionId: number): Promise<RemisionRenglon[]> {
  const result = await client.execute({
    sql: "SELECT * FROM remision_renglones WHERE remision_id = ?1 ORDER BY numero_renglon",
    args: [remisionId],
  });
  return result.rows as unknown as RemisionRenglon[];
}

// Mismo patrón que deletePrintItemOrder/deletePrintItemPurchase (Imprenta):
// borrado real, no un flag — remision_renglones se borra primero por la FK.
export async function deleteRemision(
  actor: Actor,
  id: number,
  usuario: string | null,
): Promise<void> {
  await assertActorAuthorized(actor, "remisiones_cancelar");
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
  await logEvent("WARNING", `Remisión #${id} eliminada`, usuario);
}

export async function listRemisionRenglonesParaHistorial(): Promise<RemisionHistorialRow[]> {
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
