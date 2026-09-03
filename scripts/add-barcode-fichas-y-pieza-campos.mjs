// One-off migration: moves the barcode image from plastic_products (Piezas)
// to products (Ficha técnica), and adds maquila/coste text fields to
// plastic_products. See src/components/ProductForm.tsx, ProductDetail.tsx,
// PlasticProductFields.tsx.
//
// Does NOT drop plastic_products.imagen_codigo_barras/imagen_codigo_barras_mime
// — the app stops reading/writing them, but the columns stay (live shared DB,
// no migration runner). See "Tablas y columnas muertas" in docs/DATABASE.md.
//
// Safe to run more than once (checks PRAGMA table_info first per column). Run with:
// node scripts/add-barcode-fichas-y-pieza-campos.mjs
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
  {
    table: "products",
    name: "imagen_codigo_barras",
    ddl: "ALTER TABLE products ADD COLUMN imagen_codigo_barras BLOB",
  },
  {
    table: "products",
    name: "imagen_codigo_barras_mime",
    ddl: "ALTER TABLE products ADD COLUMN imagen_codigo_barras_mime TEXT",
  },
  {
    table: "plastic_products",
    name: "maquila",
    ddl: "ALTER TABLE plastic_products ADD COLUMN maquila TEXT NOT NULL DEFAULT ''",
  },
  {
    table: "plastic_products",
    name: "coste",
    ddl: "ALTER TABLE plastic_products ADD COLUMN coste TEXT NOT NULL DEFAULT ''",
  },
];

async function main() {
  const tableInfoCache = new Map();
  for (const column of COLUMNS) {
    if (!tableInfoCache.has(column.table)) {
      const info = await client.execute(`PRAGMA table_info(${column.table})`);
      tableInfoCache.set(column.table, new Set(info.rows.map((row) => row.name)));
    }
    const existing = tableInfoCache.get(column.table);
    if (existing.has(column.name)) {
      console.log(`${column.table}.${column.name} ya existe — nada que hacer.`);
      continue;
    }
    await client.execute(column.ddl);
    console.log(`Columna ${column.table}.${column.name} agregada.`);
  }
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
