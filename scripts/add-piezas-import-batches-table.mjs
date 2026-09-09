// One-off migration: crea la tabla `piezas_import_batches`, usada por la
// importación masiva de piezas (src/components/PiezasImportPanel.tsx) para
// poder deshacer la última importación — guarda, por cada corrida exitosa,
// la lista de IDs de plastic_products recién CREADOS (no los actualizados,
// esos no se pueden deshacer sin perder los datos previos). Puramente
// aditiva — no toca ninguna tabla ni dato existente.
//
// Safe to run more than once (CREATE TABLE IF NOT EXISTS). Run with:
// node scripts/add-piezas-import-batches-table.mjs
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
    CREATE TABLE IF NOT EXISTS piezas_import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creado_en TEXT NOT NULL DEFAULT (datetime('now')),
      creado_por TEXT,
      plastic_product_ids TEXT NOT NULL,
      total INTEGER NOT NULL,
      deshecho_en TEXT
    )
  `);
  console.log("Tabla piezas_import_batches lista.");
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
