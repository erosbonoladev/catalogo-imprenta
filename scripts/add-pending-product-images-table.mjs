// One-off migration: crea la tabla `pending_product_images`, usada por la
// importación masiva de imágenes (src/components/ImageImportPanel.tsx) para
// guardar una imagen cuyo SKU no corresponde a ninguna ficha técnica
// existente todavía — se aplica sola cuando más adelante se crea un
// producto con ese código (ver applyPendingProductImage/createProduct en
// src/db.ts). Puramente aditiva — no toca ninguna tabla ni dato existente.
//
// Safe to run more than once (CREATE TABLE IF NOT EXISTS). Run with:
// node scripts/add-pending-product-images-table.mjs
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
    CREATE TABLE IF NOT EXISTS pending_product_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT NOT NULL UNIQUE,
      imagen BLOB NOT NULL,
      imagen_mime TEXT NOT NULL,
      archivo_original TEXT,
      creado_por TEXT,
      creado_en TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  console.log("Tabla pending_product_images lista.");
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
