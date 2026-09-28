// One-off migration: agrega 4 columnas de empaque a `products` (ficha
// técnica) — dimensiones_empaque, juegos_por_empaque, peso_empaque,
// volumen_empaque — y migra los datos existentes de
// `plastic_products.dimensiones_empaque` (que vivían ahí hasta ahora,
// repetidos idénticos en cada pieza de un mismo juego, confirmado contra
// Turso el 2026-09-24: 130 piezas con dato real, todas coincidentes por
// juego) hacia la ficha correspondiente, vía product_plastic_items. Las
// otras 3 columnas nuevas no tenían dato previo en Piezas (0 filas), no hay
// nada que migrar para esas. `plastic_products.dimensiones_empaque` queda
// muerta (no se dropea, BD compartida en vivo) — ver
// docs/DATABASE.md "Tablas y columnas muertas".
//
// Safe to run more than once (checks PRAGMA table_info first, y el UPDATE de
// datos solo toca products.dimensiones_empaque donde está vacío). Run with:
// node scripts/add-productos-empaque-columns.mjs
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

const COLUMNS = ["dimensiones_empaque", "juegos_por_empaque", "peso_empaque", "volumen_empaque"];

async function main() {
  const info = await client.execute("PRAGMA table_info(products)");
  const existing = new Set(info.rows.map((row) => row.name));
  for (const column of COLUMNS) {
    if (existing.has(column)) {
      console.log(`products.${column} ya existe — nada que hacer.`);
      continue;
    }
    await client.execute(`ALTER TABLE products ADD COLUMN ${column} TEXT`);
    console.log(`Columna products.${column} agregada.`);
  }

  // Migra dimensiones_empaque: para cada producto sin valor propio todavía,
  // toma el primer valor no vacío entre sus piezas ligadas (product_plastic_items
  // -> plastic_products), en orden de product_plastic_items.orden.
  const candidatos = await client.execute(`
    SELECT p.id AS product_id, pp.dimensiones_empaque AS valor
    FROM products p
    JOIN product_plastic_items ppi ON ppi.product_id = p.id
    JOIN plastic_products pp ON pp.id = ppi.plastic_product_id
    WHERE TRIM(COALESCE(p.dimensiones_empaque, '')) = ''
      AND TRIM(COALESCE(pp.dimensiones_empaque, '')) != ''
    ORDER BY p.id, ppi.orden, ppi.id
  `);
  const primerValorPorProducto = new Map();
  for (const row of candidatos.rows) {
    if (!primerValorPorProducto.has(row.product_id)) {
      primerValorPorProducto.set(row.product_id, row.valor);
    }
  }
  let migrados = 0;
  for (const [productId, valor] of primerValorPorProducto) {
    await client.execute({
      sql: "UPDATE products SET dimensiones_empaque = ?1 WHERE id = ?2",
      args: [valor, productId],
    });
    migrados += 1;
  }
  console.log(`Dimensiones de empaque migradas a ${migrados} ficha(s) desde sus piezas.`);
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
