import { createClient } from "@libsql/client/web";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import type {
  AppLog,
  ConnectedUser,
  ImageBlob,
  LogLevel,
  PlacasExistentes,
  Permiso,
  PlasticPiece,
  PrintItem,
  PrintItemCheck,
  PrintItemExtra,
  PrintItemOrder,
  PrintItemPurchase,
  Product,
  ProductInput,
  ProductSpec,
  Rol,
  SearchFilter,
  User,
  UserInput,
} from "./types";
import { PROCESOS_IMPRENTA } from "./types";

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
  creado_en: string;
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
    creado_en: row.creado_en,
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

export async function getProductSpecs(
  productId: number,
): Promise<ProductSpec[]> {
  const result = await client.execute({
    sql: "SELECT * FROM product_specs WHERE product_id = ?1 ORDER BY orden, id",
    args: [productId],
  });
  return result.rows as unknown as ProductSpec[];
}

export async function createProduct(
  product: ProductInput,
  specs: ProductSpec[],
): Promise<number> {
  const result = await client.execute({
    sql: `INSERT INTO products (codigo, nombre, categoria, material, descripcion, imagen, imagen_mime)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
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
  return productId;
}

export async function updateProduct(
  id: number,
  product: ProductInput,
  specs: ProductSpec[],
): Promise<void> {
  await client.execute({
    sql: `UPDATE products
          SET codigo = ?1, nombre = ?2, categoria = ?3, material = ?4, descripcion = ?5, imagen = ?6, imagen_mime = ?7
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
      sql: `INSERT INTO product_specs (product_id, etiqueta, valor, orden) VALUES (?1, ?2, ?3, ?4)`,
      args: [productId, etiqueta, valor, orden],
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

const MIME_BY_EXT: Record<string, string> = {
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

export async function verifyLogin(
  username: string,
  password: string,
): Promise<User | null> {
  const result = await client.execute({
    sql: "SELECT * FROM users WHERE username = ?1",
    args: [username.trim()],
  });
  const row = result.rows[0] as unknown as UserRow | undefined;
  if (!row || !row.activo) return null;
  const ok = await invoke<boolean>("verify_password", {
    password,
    hash: row.password_hash,
  });
  return ok ? rowToUser(row) : null;
}

export async function getUserById(id: number): Promise<User | null> {
  const result = await client.execute({
    sql: "SELECT * FROM users WHERE id = ?1",
    args: [id],
  });
  const row = result.rows[0] as unknown as UserRow | undefined;
  return row ? rowToUser(row) : null;
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
      sql: `UPDATE users SET username = ?1, activo = ?2, rol = ?3, password_hash = ?4 WHERE id = ?5`,
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

export async function getPrintItems(productId: number): Promise<PrintItem[]> {
  const result = await client.execute({
    sql: "SELECT * FROM product_print_items WHERE product_id = ?1 ORDER BY orden, id",
    args: [productId],
  });
  const items: PrintItem[] = [];
  for (const row of result.rows as unknown as PrintItemRow[]) {
    const [checkResult, extraResult] = await Promise.all([
      client.execute({
        sql: "SELECT * FROM product_print_item_checks WHERE print_item_id = ?1 ORDER BY orden, id",
        args: [row.id],
      }),
      client.execute({
        sql: "SELECT * FROM product_print_item_extras WHERE print_item_id = ?1 ORDER BY orden, id",
        args: [row.id],
      }),
    ]);
    const checks = (
      checkResult.rows as unknown as (Omit<PrintItemCheck, "marcado"> & {
        marcado: number;
      })[]
    ).map((check) => ({ ...check, marcado: Boolean(check.marcado) }));
    const extras = extraResult.rows as unknown as PrintItemExtra[];
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
  },
  usuario?: string | null,
): Promise<PrintItemOrder> {
  const result = await client.execute({
    sql: `INSERT INTO product_print_item_orders
          (print_item_id, merma, cantidad_arte, numero_tiros, formacion_usada, numero_pliegos_usado, total_pliegos, usuario)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
    args: [
      printItemId,
      input.merma,
      input.cantidadArte,
      input.numeroTiros,
      input.formacionUsada,
      input.numeroPliegosUsado,
      input.totalPliegos,
      usuario ?? null,
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
  },
  usuario?: string | null,
): Promise<PrintItemPurchase> {
  const result = await client.execute({
    sql: `INSERT INTO product_print_item_purchases
          (print_item_order_id, papel, pliego, maquina, cortes, cantidad, total_tamanos, usuario)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
    args: [
      printItemOrderId,
      input.papel,
      input.pliego,
      input.maquina,
      input.cortes,
      input.cantidad,
      input.totalTamanos,
      usuario ?? null,
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
