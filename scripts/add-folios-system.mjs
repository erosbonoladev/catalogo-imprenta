// One-off migration: creates the `folios` table (centralized folio system,
// see src/folios.ts and db.ts createFolio) and adds a nullable `folio` column
// to the three existing tables that display folios in their history UI:
// product_print_item_orders, product_print_item_purchases, requisiciones.
//
// Safe to run more than once (CREATE TABLE IF NOT EXISTS + PRAGMA table_info
// checks before each ALTER TABLE). Run with:
// node scripts/add-folios-system.mjs
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
  { table: "product_print_item_orders", column: "folio", ddl: "ALTER TABLE product_print_item_orders ADD COLUMN folio TEXT" },
  { table: "product_print_item_purchases", column: "folio", ddl: "ALTER TABLE product_print_item_purchases ADD COLUMN folio TEXT" },
  { table: "requisiciones", column: "folio", ddl: "ALTER TABLE requisiciones ADD COLUMN folio TEXT" },
];

async function main() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS folios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seccion TEXT NOT NULL,
      consecutivo INTEGER NOT NULL,
      folio TEXT NOT NULL DEFAULT '',
      sku TEXT NOT NULL,
      creado_en TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  console.log("Tabla folios lista.");

  // NOTA: a propósito NO hay índice único sobre la columna `folio`. createFolio
  // inserta primero con folio='' (placeholder) y recién después arma y guarda
  // el string final vía UPDATE — si `folio` tuviera un índice único, dos
  // inserciones simultáneas de secciones distintas (p.ej. una Producción y una
  // Compra al mismo tiempo) colisionarían sobre ese mismo placeholder. El
  // único índice que hace falta es (seccion, consecutivo), que sí es único.
  await client.execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_folios_seccion_consecutivo ON folios(seccion, consecutivo)",
  );
  console.log("Índice único listo.");

  for (const col of COLUMNS) {
    const info = await client.execute(`PRAGMA table_info(${col.table})`);
    const existing = new Set(info.rows.map((row) => row.name));
    if (existing.has(col.column)) {
      console.log(`${col.table}.${col.column} ya existe — nada que hacer.`);
      continue;
    }
    await client.execute(col.ddl);
    console.log(`Columna ${col.table}.${col.column} agregada.`);
  }
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
