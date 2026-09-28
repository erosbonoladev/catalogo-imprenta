// One-off migration: crea la tabla `precios_produccion` (un solo valor de
// costo de producción por producto/ficha técnica, capturado a mano).
// Deliberadamente independiente de `precios`/`precios_historial` ("Precios
// Imprenta", ligada a Remisiones por SKU) y de `precios_venta` (5 categorías
// de precio de venta al público) — no se mezcla con ninguna de las dos, ver
// docs/DATABASE.md. A diferencia de `precios_venta`, acá `product_id` es la
// propia PRIMARY KEY (una sola fila por producto, no varias categorías), así
// que no hace falta un `id` autoincremental aparte. Puramente aditiva — no
// toca ninguna tabla existente.
//
// Safe to run more than once (CREATE TABLE IF NOT EXISTS). Run with:
// node scripts/add-precios-produccion-table.mjs
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
    CREATE TABLE IF NOT EXISTS precios_produccion (
      product_id INTEGER PRIMARY KEY REFERENCES products(id),
      precio REAL,
      actualizado_en TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_por TEXT,
      creado_en TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  console.log("Tabla precios_produccion lista.");
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
