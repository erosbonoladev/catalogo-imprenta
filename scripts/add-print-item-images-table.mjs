// One-off migration: creates the `product_print_item_images` table used by
// the "Imágenes de armado" carousel in the Imprenta section (see
// src/db.ts getPrintItems/savePrintItems, src/components/ImprentaSection.tsx,
// src/components/PrintItemImagesCarousel.tsx). Purely additive — does not
// touch any existing table or data.
//
// Safe to run more than once (CREATE TABLE IF NOT EXISTS). Run with:
// node scripts/add-print-item-images-table.mjs
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
    CREATE TABLE IF NOT EXISTS product_print_item_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      print_item_id INTEGER NOT NULL REFERENCES product_print_items(id),
      imagen BLOB NOT NULL,
      imagen_mime TEXT NOT NULL,
      orden INTEGER NOT NULL
    )
  `);
  console.log("Tabla product_print_item_images lista.");

  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_print_item_images_item ON product_print_item_images(print_item_id)",
  );
  console.log("Índice listo.");
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
