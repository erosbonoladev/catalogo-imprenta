// One-off migration: turns Plásticos from per-product embedded pieces
// (product_plastic_pieces) into a reusable catalog (plastic_products) linked
// to fichas técnicas via a join table (product_plastic_items).
//
// Safe to run only once. Run with: node scripts/migrate-plasticos-catalog.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

function loadEnv() {
  const text = readFileSync(join(rootDir, ".env"), "utf-8");
  const env = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

const env = loadEnv();
const client = createClient({
  url: env.VITE_TURSO_URL,
  authToken: env.VITE_TURSO_AUTH_TOKEN,
});

async function main() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS plastic_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL DEFAULT '',
      sku TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '',
      origen TEXT NOT NULL DEFAULT '',
      descripcion TEXT NOT NULL DEFAULT '',
      armado TEXT NOT NULL DEFAULT '',
      dimension TEXT NOT NULL DEFAULT '',
      peso TEXT NOT NULL DEFAULT '',
      tipo_empaque TEXT NOT NULL DEFAULT '',
      imagen BLOB,
      imagen_mime TEXT,
      imagen_codigo_barras BLOB,
      imagen_codigo_barras_mime TEXT,
      creado_en TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS product_plastic_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      plastic_product_id INTEGER NOT NULL REFERENCES plastic_products(id),
      orden INTEGER NOT NULL DEFAULT 1
    )
  `);

  const alreadyLinked = await client.execute("SELECT COUNT(*) AS n FROM product_plastic_items");
  if (Number(alreadyLinked.rows[0].n) > 0) {
    console.log(
      `product_plastic_items ya tiene ${alreadyLinked.rows[0].n} fila(s) — la migración ya se corrió antes. Abortando para no duplicar.`,
    );
    return;
  }

  const before = await client.execute("SELECT COUNT(*) AS n FROM product_plastic_pieces");
  const totalBefore = Number(before.rows[0].n);
  console.log(`product_plastic_pieces tiene ${totalBefore} fila(s) para migrar.`);

  const pieces = await client.execute(
    "SELECT * FROM product_plastic_pieces ORDER BY product_id, orden, id",
  );

  let migrated = 0;
  for (const row of pieces.rows) {
    const sku = String(row.sku ?? "");
    const color = String(row.color ?? "");
    const inserted = await client.execute({
      sql: `INSERT INTO plastic_products (nombre, sku, color, imagen, imagen_mime)
            VALUES (?1, ?2, ?3, ?4, ?5)`,
      args: [sku, sku, color, row.imagen ?? null, row.imagen_mime ?? null],
    });
    const plasticProductId = Number(inserted.lastInsertRowid);
    await client.execute({
      sql: `INSERT INTO product_plastic_items (product_id, plastic_product_id, orden)
            VALUES (?1, ?2, ?3)`,
      args: [row.product_id, plasticProductId, row.orden],
    });
    migrated += 1;
  }

  const afterProducts = await client.execute("SELECT COUNT(*) AS n FROM plastic_products");
  const afterItems = await client.execute("SELECT COUNT(*) AS n FROM product_plastic_items");
  console.log(`Migradas ${migrated} de ${totalBefore} pieza(s).`);
  console.log(`plastic_products ahora tiene ${afterProducts.rows[0].n} fila(s).`);
  console.log(`product_plastic_items ahora tiene ${afterItems.rows[0].n} fila(s).`);
  if (migrated !== totalBefore || Number(afterItems.rows[0].n) !== totalBefore) {
    console.warn("Advertencia: los conteos no coinciden — revisar antes de continuar.");
  }
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
