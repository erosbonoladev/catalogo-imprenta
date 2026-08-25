// One-off migration: adds products.presentacion_original, used to preserve the
// raw "Presentación / Contenido" text from bulk Excel imports (see
// src/fichaImport.ts) alongside the structured product_specs rows parsed from it.
//
// Safe to run more than once (checks PRAGMA table_info first). Run with:
// node scripts/add-presentacion-original-column.mjs
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
  const info = await client.execute("PRAGMA table_info(products)");
  const hasColumn = info.rows.some((row) => row.name === "presentacion_original");
  if (hasColumn) {
    console.log("products.presentacion_original ya existe — nada que hacer.");
    return;
  }

  await client.execute(
    "ALTER TABLE products ADD COLUMN presentacion_original TEXT NOT NULL DEFAULT ''",
  );
  console.log("Columna products.presentacion_original agregada.");
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
