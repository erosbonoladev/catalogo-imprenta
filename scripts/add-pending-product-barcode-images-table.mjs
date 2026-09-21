// One-off migration: crea la tabla `pending_product_barcode_images`, usada
// por la captura masiva de imágenes de código de barras
// (src/components/BarcodeImageImportPanel.tsx) para guardar una imagen cuyo
// código de barras no corresponde a ninguna ficha técnica existente todavía
// — se aplica sola cuando más adelante se crea un producto con ese
// codigo_barras_texto (ver applyPendingProductBarcodeImage/createProduct en
// src/db.ts). Mismo patrón que pending_product_images (scripts/add-pending-
// product-images-table.mjs), indexada por codigo_barras en vez de codigo.
// Puramente aditiva — no toca ninguna tabla ni dato existente.
//
// Safe to run more than once (CREATE TABLE IF NOT EXISTS). Run with:
// node scripts/add-pending-product-barcode-images-table.mjs
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
    CREATE TABLE IF NOT EXISTS pending_product_barcode_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo_barras TEXT NOT NULL UNIQUE,
      imagen BLOB NOT NULL,
      imagen_mime TEXT NOT NULL,
      archivo_original TEXT,
      creado_por TEXT,
      creado_en TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  console.log("Tabla pending_product_barcode_images lista.");
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
