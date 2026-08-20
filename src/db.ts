import { createClient } from "@libsql/client/web";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import type {
  ImageBlob,
  PlasticPiece,
  PrintItem,
  PrintItemCheck,
  PrintItemExtra,
  Product,
  ProductInput,
  ProductSpec,
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

export async function searchProducts(query: string): Promise<Product[]> {
  const trimmed = query.trim();
  const result = trimmed
    ? await client.execute({
        sql: "SELECT * FROM products WHERE codigo LIKE ?1 OR nombre LIKE ?1 OR material LIKE ?1 ORDER BY nombre, material",
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

// --- Sección privada (Plásticos / Imprenta) ---

export async function getSectionPasswordHash(
  section: string,
): Promise<string | null> {
  const result = await client.execute({
    sql: "SELECT password_hash FROM section_passwords WHERE section = ?1",
    args: [section],
  });
  const row = result.rows[0] as unknown as { password_hash: string } | undefined;
  return row?.password_hash ?? null;
}

export async function setSectionPassword(
  section: string,
  password: string,
): Promise<void> {
  const hash = await invoke<string>("hash_password", { password });
  await client.execute({
    sql: `INSERT INTO section_passwords (section, password_hash) VALUES (?1, ?2)
          ON CONFLICT(section) DO UPDATE SET password_hash = ?3`,
    args: [section, hash, hash],
  });
}

export async function checkSectionPassword(
  section: string,
  password: string,
): Promise<boolean> {
  const hash = await getSectionPasswordHash(section);
  if (!hash) return false;
  return invoke<boolean>("verify_password", { password, hash });
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
  for (const row of existing.rows as unknown as { id: number }[]) {
    await client.execute({
      sql: "DELETE FROM product_print_item_checks WHERE print_item_id = ?1",
      args: [row.id],
    });
    await client.execute({
      sql: "DELETE FROM product_print_item_extras WHERE print_item_id = ?1",
      args: [row.id],
    });
  }
  await client.execute({
    sql: "DELETE FROM product_print_items WHERE product_id = ?1",
    args: [productId],
  });
  let orden = 1;
  for (const item of items) {
    const nombre = item.nombre.trim();
    if (!nombre) continue;
    const result = await client.execute({
      sql: `INSERT INTO product_print_items (
              product_id, nombre, tamano, tipo_papel, tintas, gramos_puntos, pliego,
              extendido, corte_cm, maquina, formacion, numero_pliegos, acabados, notas, orden
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
      args: [
        productId,
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
        orden,
      ],
    });
    const printItemId = Number(result.lastInsertRowid);
    let checkOrden = 1;
    for (const check of item.checks) {
      await client.execute({
        sql: `INSERT INTO product_print_item_checks (print_item_id, nombre, marcado, orden)
              VALUES (?1, ?2, ?3, ?4)`,
        args: [printItemId, check.nombre.trim(), check.marcado ? 1 : 0, checkOrden],
      });
      checkOrden += 1;
    }
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
}
