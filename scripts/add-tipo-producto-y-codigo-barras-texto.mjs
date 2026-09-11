// One-off migration: agrega a `products` las columnas `tipo_producto` (valor
// controlado, ver TIPOS_PRODUCTO en src/types.ts — validado en
// createProduct/updateProduct, no a nivel de columna) y `codigo_barras_texto`
// (código de barras en texto, distinto de la imagen imagen_codigo_barras que
// ya existía). Ambas TEXT nullable, puramente aditivo — no toca datos
// existentes ni ninguna otra tabla.
//
// Safe to run more than once (checks PRAGMA table_info first). Run with:
// node scripts/add-tipo-producto-y-codigo-barras-texto.mjs
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
  { name: "tipo_producto", ddl: "ALTER TABLE products ADD COLUMN tipo_producto TEXT" },
  { name: "codigo_barras_texto", ddl: "ALTER TABLE products ADD COLUMN codigo_barras_texto TEXT" },
];

async function main() {
  const info = await client.execute("PRAGMA table_info(products)");
  const existing = new Set(info.rows.map((row) => row.name));
  for (const column of COLUMNS) {
    if (existing.has(column.name)) {
      console.log(`products.${column.name} ya existe — nada que hacer.`);
      continue;
    }
    await client.execute(column.ddl);
    console.log(`Columna products.${column.name} agregada.`);
  }
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
