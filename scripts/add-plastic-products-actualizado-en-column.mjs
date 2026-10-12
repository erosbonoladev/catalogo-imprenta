// One-off migration: agrega la columna "actualizado_en" a plastic_products.
// Hasta ahora una pieza solo guardaba creado_en, así que no había forma de
// saber qué piezas se modificaron en un día — la necesita "Exportar avance
// del día" en SKU Master (ver src/db.ts, getReporteDiarioData). NULL = pieza
// que no se ha vuelto a tocar desde esta migración (se trata como si su
// última modificación fuera creado_en); no se rellena con datos inventados.
//
// Safe to run more than once (checks PRAGMA table_info first). Run with:
// node scripts/add-plastic-products-actualizado-en-column.mjs
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
  const info = await client.execute("PRAGMA table_info(plastic_products)");
  const existing = new Set(info.rows.map((row) => row.name));
  if (existing.has("actualizado_en")) {
    console.log("plastic_products.actualizado_en ya existe — nada que hacer.");
    return;
  }
  await client.execute("ALTER TABLE plastic_products ADD COLUMN actualizado_en TEXT");
  console.log("Columna plastic_products.actualizado_en agregada.");
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
