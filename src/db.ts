import Database from "@tauri-apps/plugin-sql";
import { appDataDir, join } from "@tauri-apps/api/path";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Product, ProductInput, ProductSpec } from "./types";

let dbPromise: Promise<Database> | null = null;

function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load("sqlite:imprenta.db");
  }
  return dbPromise;
}

export async function searchProducts(query: string): Promise<Product[]> {
  const db = await getDb();
  const trimmed = query.trim();
  if (!trimmed) {
    return db.select<Product[]>(
      "SELECT * FROM products ORDER BY nombre, material",
    );
  }
  const like = `%${trimmed}%`;
  return db.select<Product[]>(
    "SELECT * FROM products WHERE codigo LIKE ?1 OR nombre LIKE ?1 OR material LIKE ?1 ORDER BY nombre, material",
    [like],
  );
}

export async function getProduct(id: number): Promise<Product | null> {
  const db = await getDb();
  const rows = await db.select<Product[]>(
    "SELECT * FROM products WHERE id = ?1",
    [id],
  );
  return rows[0] ?? null;
}

export async function getProductSpecs(
  productId: number,
): Promise<ProductSpec[]> {
  const db = await getDb();
  return db.select<ProductSpec[]>(
    "SELECT * FROM product_specs WHERE product_id = ?1 ORDER BY orden, id",
    [productId],
  );
}

export async function createProduct(
  product: ProductInput,
  specs: ProductSpec[],
): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO products (codigo, nombre, categoria, material, descripcion, imagen)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    [
      product.codigo,
      product.nombre,
      product.categoria,
      product.material,
      product.descripcion,
      product.imagen,
    ],
  );
  const productId = result.lastInsertId as number;
  await insertSpecs(db, productId, specs);
  return productId;
}

export async function updateProduct(
  id: number,
  product: ProductInput,
  specs: ProductSpec[],
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE products
     SET codigo = ?1, nombre = ?2, categoria = ?3, material = ?4, descripcion = ?5, imagen = ?6
     WHERE id = ?7`,
    [
      product.codigo,
      product.nombre,
      product.categoria,
      product.material,
      product.descripcion,
      product.imagen,
      id,
    ],
  );
  await db.execute("DELETE FROM product_specs WHERE product_id = ?1", [id]);
  await insertSpecs(db, id, specs);
}

async function insertSpecs(
  db: Database,
  productId: number,
  specs: ProductSpec[],
): Promise<void> {
  let orden = 1;
  for (const spec of specs) {
    const etiqueta = spec.etiqueta.trim();
    const valor = spec.valor.trim();
    if (!etiqueta || !valor) continue;
    await db.execute(
      `INSERT INTO product_specs (product_id, etiqueta, valor, orden) VALUES (?1, ?2, ?3, ?4)`,
      [productId, etiqueta, valor, orden],
    );
    orden += 1;
  }
}

export async function deleteProduct(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM products WHERE id = ?1", [id]);
}

export async function codigoEnUso(
  codigo: string,
  excludeId?: number,
): Promise<boolean> {
  const db = await getDb();
  const rows = await db.select<{ id: number }[]>(
    "SELECT id FROM products WHERE codigo = ?1",
    [codigo.trim()],
  );
  return rows.some((row) => row.id !== excludeId);
}

export async function getImageSrc(
  imagen: string | null,
): Promise<string | null> {
  if (!imagen) return null;
  const dir = await appDataDir();
  const fullPath = await join(dir, "images", imagen);
  return convertFileSrc(fullPath);
}

export async function pickAndSaveImage(
  codigo: string,
): Promise<string | null> {
  const selected = await open({
    multiple: false,
    filters: [
      { name: "Imágenes", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
    ],
  });
  if (!selected || Array.isArray(selected)) return null;
  return invoke<string>("guardar_imagen_producto", {
    rutaOrigen: selected,
    codigo: codigo.trim() || "producto",
  });
}
