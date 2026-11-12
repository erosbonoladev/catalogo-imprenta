// One-off migration: agrega la columna "kit_product_id" a product_plastic_items
// (vínculo ficha↔pieza) — id de la ficha (kit) desde la que se trajo esa pieza
// con el botón "KIT" de Piezas. NULL = la pieza no vino de un kit. Vive en el
// vínculo, no en plastic_products, porque la misma pieza puede estar en un
// juego por haberla traído de un kit y en otro por haberla agregado a mano.
// Alimenta la lista "Productos que conforman este kit" de ProductDetail
// (getKitProductos). Sin FK: si el kit de origen se borra, el vínculo sigue
// y la lista simplemente deja de mostrarlo (el JOIN con products no lo encuentra).
//
// Safe to run more than once (checks PRAGMA table_info first). Run with:
// node scripts/add-product-plastic-items-kit-column.mjs
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
  const info = await client.execute("PRAGMA table_info(product_plastic_items)");
  const existing = new Set(info.rows.map((row) => row.name));
  if (existing.has("kit_product_id")) {
    console.log("product_plastic_items.kit_product_id ya existe — nada que hacer.");
    return;
  }
  await client.execute(
    "ALTER TABLE product_plastic_items ADD COLUMN kit_product_id INTEGER",
  );
  console.log("Columna product_plastic_items.kit_product_id agregada.");
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
