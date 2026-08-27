// One-off migration: creates the `requisiciones` table used by the
// "Requisición" button on fichas técnicas (see src/db.ts createRequisicion,
// src/components/RequisicionModal.tsx). Purely additive — does not touch any
// existing table or data.
//
// Safe to run more than once (CREATE TABLE IF NOT EXISTS). Run with:
// node scripts/create-requisiciones-table.mjs
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
    CREATE TABLE IF NOT EXISTS requisiciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      fecha TEXT NOT NULL,
      numero_dia INTEGER NOT NULL,
      usuario TEXT,
      etiqueta TEXT NOT NULL,
      descripcion TEXT,
      cantidad REAL NOT NULL,
      estado TEXT NOT NULL DEFAULT 'pendiente',
      mensaje TEXT NOT NULL DEFAULT '',
      creado_en TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  console.log("Tabla requisiciones lista.");

  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_requisiciones_fecha ON requisiciones(fecha)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_requisiciones_product ON requisiciones(product_id)",
  );
  console.log("Índices listos.");
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
