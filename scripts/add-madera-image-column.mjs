// One-off migration: agrega columnas de imagen a wood_products (Maderas) —
// mismo tratamiento que products/plastic_products/product_print_item_images
// (BLOB `imagen` + `imagen_mime`). No estaba en el diseño original (el
// Excel de Maderas no trae columna de imagen), se agregó a pedido del
// usuario después de ver la sección en uso: "poder ver una foto del
// producto, en la esquina inferior derecha, igual que imágenes de armado
// en Imprenta".
//
// Safe to run more than once (checks PRAGMA table_info first). Run with:
// node scripts/add-madera-image-column.mjs
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

const COLUMNS = [
  { name: "imagen", ddl: "ALTER TABLE wood_products ADD COLUMN imagen BLOB" },
  { name: "imagen_mime", ddl: "ALTER TABLE wood_products ADD COLUMN imagen_mime TEXT" },
];

async function main() {
  const info = await client.execute("PRAGMA table_info(wood_products)");
  const existing = new Set(info.rows.map((row) => row.name));
  for (const column of COLUMNS) {
    if (existing.has(column.name)) {
      console.log(`wood_products.${column.name} ya existe — nada que hacer.`);
      continue;
    }
    await client.execute(column.ddl);
    console.log(`Columna wood_products.${column.name} agregada.`);
  }
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
