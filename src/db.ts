import { createClient } from "@libsql/client/web";
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
  product: ProductInput,
  specs: ProductSpec[],
  descriptions: ProductDescription[] = [],
): Promise<number> {
  const result = await client.execute({
    sql: `INSERT INTO products (codigo, nombre, categoria, material, descripcion, imagen, imagen_mime, actualizado_en)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))`,
    args: [
      product.codigo,
      product.nombre,
      product.categoria,
      product.material,
      product.descripcion,
      product.imagen?.data ?? null,
      product.imagen?.mime ?? null,
    ],
  });
  const productId = Number(result.lastInsertRowid);
  await insertSpecs(productId, specs);
  await insertDescriptions(productId, descriptions);
  return productId;
}

export async function updateProduct(
  id: number,
  product: ProductInput,
  specs: ProductSpec[],
  descriptions: ProductDescription[] = [],
): Promise<void> {
  await client.execute({
    sql: `UPDATE products
          SET codigo = ?1, nombre = ?2, categoria = ?3, material = ?4, descripcion = ?5, imagen = ?6, imagen_mime = ?7,
              actualizado_en = datetime('now')
          WHERE id = ?8`,
    args: [
      product.codigo,
      product.nombre,
      product.categoria,
      product.material,
      product.descripcion,
      product.imagen?.data ?? null,
      product.imagen?.mime ?? null,
      id,
    ],
  });
  await client.execute({
    sql: "DELETE FROM product_specs WHERE product_id = ?1",
    args: [id],
  });
  await insertSpecs(id, specs);
  await client.execute({
    sql: "DELETE FROM product_descriptions WHERE product_id = ?1",
    args: [id],
  });
  await insertDescriptions(id, descriptions);
}

async function insertSpecs(
  productId: number,
  specs: ProductSpec[],
): Promise<void> {
  let orden = 1;
  for (const spec of specs) {
    const etiqueta = spec.etiqueta.trim();
    const valor = spec.valor.trim();
    if (!etiqueta || !valor) continue;
    await client.execute({
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
  productId: number,
  descriptions: ProductDescription[],
): Promise<void> {
  let orden = 1;
  for (const description of descriptions) {
    const etiqueta = description.etiqueta.trim();
    const texto = description.texto.trim();
    if (!etiqueta || !texto) continue;
    await client.execute({
      sql: `INSERT INTO product_descriptions (product_id, etiqueta, texto, orden) VALUES (?1, ?2, ?3, ?4)`,
      args: [productId, etiqueta, texto, orden],
    });
    orden += 1;
  }
}

export async function deleteProduct(id: number): Promise<void> {
  await client.execute({
    sql: "DELETE FROM product_specs WHERE product_id = ?1",
    args: [id],
  });
  await client.execute({
    sql: "DELETE FROM product_descriptions WHERE product_id = ?1",
    args: [id],
  });
  await client.execute({
    sql: "DELETE FROM product_plastic_pieces WHERE product_id = ?1",
    args: [id],
  });
  const items = await client.execute({
    sql: "SELECT id FROM product_print_items WHERE product_id = ?1",
    args: [id],
  });
  for (const row of items.rows as unknown as { id: number }[]) {
    await client.execute({
      sql: "DELETE FROM product_print_item_checks WHERE print_item_id = ?1",
      args: [row.id],
    });
    await client.execute({
      sql: "DELETE FROM product_print_item_extras WHERE print_item_id = ?1",
      args: [row.id],
    });
    await client.execute({
      sql: "DELETE FROM product_print_item_images WHERE print_item_id = ?1",
      args: [row.id],
    });
    await client.execute({
      sql: `DELETE FROM product_print_item_purchases WHERE print_item_order_id IN
            (SELECT id FROM product_print_item_orders WHERE print_item_id = ?1)`,
      args: [row.id],
    });
    await client.execute({
      sql: "DELETE FROM product_print_item_orders WHERE print_item_id = ?1",
      args: [row.id],
    });
  }
  await client.execute({
    sql: "DELETE FROM product_print_items WHERE product_id = ?1",
    args: [id],
  });
  await client.execute({ sql: "DELETE FROM products WHERE id = ?1", args: [id] });
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

export async function pickImage(): Promise<ImageBlob | null> {
  const selected = await open({
    multiple: false,
    filters: [
      { name: "Imágenes", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
    ],
  });
  if (!selected || Array.isArray(selected)) return null;
  const data = await readFile(selected);
  const ext = selected.split(".").pop()?.toLowerCase() ?? "";
  const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
  return { data, mime };
}

export async function pickExcelFile(): Promise<Uint8Array | null> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "Excel", extensions: ["xlsx"] }],
  });
  if (!selected || Array.isArray(selected)) return null;
  return readFile(selected);
}

export interface ImageFolderEntry {
  name: string;
  path: string;
}

export async function pickImageFolder(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  if (!selected || Array.isArray(selected)) return null;
  return selected;
}

export async function listImageFolderFiles(
  folderPath: string,
): Promise<ImageFolderEntry[]> {
  const entries = await readDir(folderPath);
  const files: ImageFolderEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile) continue;
    files.push({ name: entry.name, path: await join(folderPath, entry.name) });
  }
  return files;
}

export async function readImageFileBlob(path: string): Promise<ImageBlob> {
  const data = await readFile(path);
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
  return { data, mime };
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
    sql: "UPDATE users SET failed_attempts = 0, locked_until = NULL, session_token = ?1 WHERE id = ?2",
    args: [token, row.id],
  });
  return { status: "ok", user: await rowToUser(row), token };
}

export async function validateSession(id: number, token: string): Promise<User | null> {
  const result = await client.execute({
    sql: "SELECT * FROM users WHERE id = ?1 AND session_token = ?2",
    args: [id, token],
  });
  const row = result.rows[0] as unknown as UserRow | undefined;
  if (!row || !row.activo) return null;
  return rowToUser(row);
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

export async function createUser(input: UserInput): Promise<number> {
  if (!input.password) throw new Error("La contraseña es obligatoria.");
  const hash = await invoke<string>("hash_password", { password: input.password });
  const result = await client.execute({
    sql: `INSERT INTO users (username, password_hash, activo, rol) VALUES (?1, ?2, ?3, ?4)`,
    args: [input.username.trim(), hash, input.activo ? 1 : 0, input.rol],
  });
  const userId = Number(result.lastInsertRowid);
  await savePermissions(userId, input.permisos);
  return userId;
}

export async function updateUser(id: number, input: UserInput): Promise<void> {
  if (input.password) {
    const hash = await invoke<string>("hash_password", { password: input.password });
    await client.execute({
      sql: `UPDATE users SET username = ?1, activo = ?2, rol = ?3, password_hash = ?4, session_token = NULL WHERE id = ?5`,
      args: [input.username.trim(), input.activo ? 1 : 0, input.rol, hash, id],
    });
  } else {
    await client.execute({
      sql: `UPDATE users SET username = ?1, activo = ?2, rol = ?3 WHERE id = ?4`,
      args: [input.username.trim(), input.activo ? 1 : 0, input.rol, id],
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
    sql: "UPDATE users SET session_token = NULL WHERE id = ?1",
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
  imagen: ArrayBuffer | null;
  imagen_mime: string | null;
  imagen_codigo_barras: ArrayBuffer | null;
  imagen_codigo_barras_mime: string | null;
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
    armado: row.armado,
    dimension: row.dimension,
    peso: row.peso,
    tipo_empaque: row.tipo_empaque,
    imagen: toImageBlob(row.imagen, row.imagen_mime),
    imagen_codigo_barras: toImageBlob(row.imagen_codigo_barras, row.imagen_codigo_barras_mime),
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
    armado: product.armado,
    dimension: product.dimension,
    peso: product.peso,
    tipo_empaque: product.tipo_empaque,
    imagen: product.imagen,
    imagen_codigo_barras: product.imagen_codigo_barras,
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

export async function createPlasticProduct(
  input: PlasticProductInput,
): Promise<number> {
  const result = await client.execute({
    sql: `INSERT INTO plastic_products
          (nombre, sku, color, origen, descripcion, armado, dimension, peso, tipo_empaque, imagen, imagen_mime, imagen_codigo_barras, imagen_codigo_barras_mime)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    args: [
      input.nombre.trim(),
      input.sku.trim(),
      input.color.trim(),
      input.origen.trim(),
      input.descripcion.trim(),
      input.armado.trim(),
      input.dimension.trim(),
      input.peso.trim(),
      input.tipo_empaque.trim(),
      input.imagen?.data ?? null,
      input.imagen?.mime ?? null,
      input.imagen_codigo_barras?.data ?? null,
      input.imagen_codigo_barras?.mime ?? null,
    ],
  });
  return Number(result.lastInsertRowid);
}

export async function updatePlasticProduct(
  id: number,
  input: PlasticProductInput,
): Promise<void> {
  await client.execute({
    sql: `UPDATE plastic_products
          SET nombre = ?1, sku = ?2, color = ?3, origen = ?4, descripcion = ?5, armado = ?6,
              dimension = ?7, peso = ?8, tipo_empaque = ?9, imagen = ?10, imagen_mime = ?11,
              imagen_codigo_barras = ?12, imagen_codigo_barras_mime = ?13
          WHERE id = ?14`,
    args: [
      input.nombre.trim(),
      input.sku.trim(),
      input.color.trim(),
      input.origen.trim(),
      input.descripcion.trim(),
      input.armado.trim(),
      input.dimension.trim(),
      input.peso.trim(),
      input.tipo_empaque.trim(),
      input.imagen?.data ?? null,
      input.imagen?.mime ?? null,
      input.imagen_codigo_barras?.data ?? null,
      input.imagen_codigo_barras?.mime ?? null,
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
  productId: number,
  items: PlasticItem[],
): Promise<void> {
  const resolved: { plasticProductId: number; orden: number }[] = [];
  let orden = 1;
  for (const item of items) {
    if (!item.data.nombre.trim() && !item.data.sku.trim()) continue;
    let plasticProductId: number;
    if (item.plastic_product_id) {
      plasticProductId = item.plastic_product_id;
      await updatePlasticProduct(plasticProductId, item.data);
    } else {
      plasticProductId = await createPlasticProduct(item.data);
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
  productId: number,
  items: PrintItem[],
): Promise<void> {
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

export async function deletePrintItemOrder(orderId: number): Promise<void> {
  await client.execute({
    sql: "DELETE FROM product_print_item_purchases WHERE print_item_order_id = ?1",
    args: [orderId],
  });
  await client.execute({
    sql: "DELETE FROM product_print_item_orders WHERE id = ?1",
    args: [orderId],
  });
}

export async function deletePrintItemPurchase(purchaseId: number): Promise<void> {
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

export async function createFolio(tipo: TipoFolio, sku: string): Promise<Folio> {
  // consecutivo se calcula dentro del mismo INSERT (subconsulta), no en un
  // SELECT previo por separado — mismo patrón que requisiciones.numero_dia,
  // mismo motivo (SQLite/libSQL serializa las escrituras). Acá el scope es
  // `seccion`, no `fecha`: el consecutivo de folios nunca se reinicia.
  const insertResult = await client.execute({
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
  await client.execute({
    sql: "UPDATE folios SET folio = ?1 WHERE id = ?2",
    args: [folio, row.id],
  });
  return { id: row.id, seccion: tipo, consecutivo: row.consecutivo, folio, sku, creado_en: row.creado_en };
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
export async function executeRestoreSql(sql: string): Promise<void> {
  const statements = extractRestoreStatements(sql);
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

export async function deleteBackupRecord(id: number): Promise<void> {
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
 * app, ya cubierto por las capabilities fs:allow-home-*-recursive
 * existentes, sin pedir un permiso nuevo ni forzar rebuild.
 */
export async function getBackupsDir(): Promise<string> {
  const dir = await join(await appDataDir(), "backups");
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

export async function saveLocalBackupFile(fileName: string, bytes: Uint8Array): Promise<string> {
  const dir = await getBackupsDir();
  const path = await join(dir, fileName);
  await writeFile(path, bytes);
  return path;
}

export async function readLocalBackupFile(path: string): Promise<Uint8Array> {
  return readFile(path);
}

export async function localBackupFileExists(path: string): Promise<boolean> {
  try {
    return await exists(path);
  } catch {
    return false;
  }
}

export async function deleteLocalBackupFile(path: string): Promise<void> {
  if (await localBackupFileExists(path)) {
    await remove(path);
  }
}

export async function saveBackupFileAs(defaultFileName: string, bytes: Uint8Array): Promise<boolean> {
  const target = await save({ defaultPath: defaultFileName });
  if (!target) return false;
  await writeFile(target, bytes);
  return true;
}

export async function updateBackupSettings(
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
  };
}

export async function upsertPrecio(
  input: PrecioInput & {
    // Solo la usa la captura masiva — preserva la fecha declarada en el
    // Excel en vez del momento real de importación (ver src/precios.ts). La
    // edición manual desde PreciosModal nunca la pasa.
    actualizadoEn?: string;
  },
): Promise<Precio> {
  const skuPrincipal = computeSkuPrincipal(input.sku);
  const existing = await client.execute({
    sql: "SELECT precio FROM precios WHERE sku = ?1",
    args: [input.sku],
  });
  const precioAnterior =
    (existing.rows[0] as unknown as { precio: number } | undefined)?.precio ?? null;

  const result = await client.execute({
    sql: `INSERT INTO precios (sku, sku_principal, nombre, precio, actualizado_en, actualizado_por)
          VALUES (?1, ?2, ?3, ?4, COALESCE(?5, datetime('now')), ?6)
          ON CONFLICT(sku) DO UPDATE SET
            sku_principal = ?2, nombre = ?3, precio = ?4,
            actualizado_en = COALESCE(?5, datetime('now')), actualizado_por = ?6
          RETURNING *`,
    args: [input.sku, skuPrincipal, input.nombre, input.precio, input.actualizadoEn ?? null, input.usuario],
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

export async function createRemision(
  input: RemisionInput,
  renglones: RemisionRenglonInput[],
): Promise<RemisionConRenglones> {
  // Header + renglones se escriben en un solo client.batch() (transacción
  // atómica de libSQL) en vez de INSERTs secuenciales sueltos: si el folio ya
  // fue consumido por createFolio() pero la escritura fallara a medias, se
  // habría quedado un documento fantasma con folio quemado y renglones
  // incompletos — ver createFolio() más arriba, mismo problema que resuelve
  // su subconsulta atómica, pero aplicado a un insert de header+líneas.
  // Cada renglón ubica su remision_id por folio (único por generación) en vez
  // de depender del id devuelto por el INSERT del header, porque batch() arma
  // todos los statements de antemano y no puede encadenar el resultado de uno
  // como argumento del siguiente.
  const statements = [
    {
      sql: `INSERT INTO remisiones
              (folio, fecha, tipo, pedido_bodegas, subtotal, descuento_pct, descuento, iva, total, precio_texto, usuario)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            RETURNING *`,
      args: [
        input.folio,
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
    },
    ...renglones.map((r, i) => ({
      sql: `INSERT INTO remision_renglones
              (remision_id, numero_renglon, sku, producto_nombre, cantidad, precio_unitario, importe)
            VALUES ((SELECT id FROM remisiones WHERE folio = ?1), ?2, ?3, ?4, ?5, ?6, ?7)
            RETURNING *`,
      args: [input.folio, i + 1, r.sku, r.producto_nombre, r.cantidad, r.precio_unitario, r.importe],
    })),
  ];

  const results = await client.batch(statements, "write");
  const headerRow = results[0].rows[0] as unknown as RemisionRow;
  const savedRenglones = results.slice(1).map((r) => r.rows[0] as unknown as RemisionRenglon);

  return { ...rowToRemision(headerRow), renglones: savedRenglones };
}

export async function listRemisiones(limit = 30): Promise<Remision[]> {
  const result = await client.execute({
    sql: "SELECT * FROM remisiones ORDER BY id DESC LIMIT ?1",
    args: [limit],
  });
  return (result.rows as unknown as RemisionRow[]).map(rowToRemision);
}

export async function cancelRemision(id: number, usuario: string | null): Promise<void> {
  await client.execute({
    sql: "UPDATE remisiones SET cancelada = 1 WHERE id = ?1",
    args: [id],
  });
  await logEvent("WARNING", `Remisión #${id} cancelada`, usuario);
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
