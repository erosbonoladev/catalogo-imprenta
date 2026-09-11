// One-off migration: crea la tabla `precios_venta` (5 categorías fijas de
// precio de venta al público — Gobierno/Representante/Mayoreo/Medio
// mayoreo/Publico sugerido, ver PRECIOS_VENTA_CATEGORIAS en src/types.ts —
// por producto/ficha técnica). Deliberadamente independiente de
// `precios`/`precios_historial` (esas siguen siendo "Precios Imprenta",
// ligadas a Remisiones por SKU) — Precios Venta se relaciona por
// `product_id` (una ficha, un juego de 5 precios), no por SKU, y no tiene
// tabla de historial propia (no se pidió). Puramente aditiva — no toca
// ninguna tabla existente.
//
// Safe to run more than once (CREATE TABLE IF NOT EXISTS). Run with:
// node scripts/add-precios-venta-table.mjs
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
    CREATE TABLE IF NOT EXISTS precios_venta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      categoria TEXT NOT NULL,
      precio REAL,
      actualizado_en TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_por TEXT,
      creado_en TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(product_id, categoria)
    )
  `);
  console.log("Tabla precios_venta lista.");

  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_precios_venta_product_id ON precios_venta(product_id)",
  );
  console.log("Índice idx_precios_venta_product_id listo.");
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
