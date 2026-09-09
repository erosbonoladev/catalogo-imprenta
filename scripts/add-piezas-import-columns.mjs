// One-off migration: agrega los campos "Componentes de fabricación" y
// "Dimensiones de empaque" a plastic_products (Piezas), mismo tratamiento
// que maquila/coste — usados por la importación masiva de piezas. Ver
// src/components/PlasticProductFields.tsx, PiezaDetalleScreen.tsx,
// PlasticosSection.tsx.
//
// Safe to run more than once (checks PRAGMA table_info first). Run with:
// node scripts/add-piezas-import-columns.mjs
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
    table: "plastic_products",
    name: "componentes_fabricacion",
    ddl: "ALTER TABLE plastic_products ADD COLUMN componentes_fabricacion TEXT NOT NULL DEFAULT ''",
  },
  {
    table: "plastic_products",
    name: "dimensiones_empaque",
    ddl: "ALTER TABLE plastic_products ADD COLUMN dimensiones_empaque TEXT NOT NULL DEFAULT ''",
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
