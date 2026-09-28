// One-off migration: agrega la columna "cantidad" a product_plastic_items
// (vínculo ficha↔pieza) — cuántas piezas de esa se usan en ese juego. Vive
// en el vínculo, no en plastic_products (catálogo maestro reutilizable),
// porque la misma pieza puede necesitarse en cantidades distintas según el
// juego. Ver src/components/PlasticosSection.tsx, src/types.ts (PlasticItem).
//
// Safe to run more than once (checks PRAGMA table_info first). Run with:
// node scripts/add-product-plastic-items-cantidad-column.mjs
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
  if (existing.has("cantidad")) {
    console.log("product_plastic_items.cantidad ya existe — nada que hacer.");
    return;
  }
  await client.execute(
    "ALTER TABLE product_plastic_items ADD COLUMN cantidad TEXT NOT NULL DEFAULT ''",
  );
  console.log("Columna product_plastic_items.cantidad agregada.");
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
