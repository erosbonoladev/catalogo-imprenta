// One-off migration: creates the `precios`/`precios_historial` tables (lista
// de precios por SKU, ver src/precios.ts, db.ts upsertPrecio) and the
// `remisiones`/`remision_renglones` tables (documento con renglones, ver
// src/components/RemisionForm.tsx, db.ts createRemision). Purely additive —
// does not touch any existing table or data.
//
// Safe to run more than once (CREATE TABLE IF NOT EXISTS). Run with:
// node scripts/add-precios-y-remisiones-tables.mjs
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
    CREATE TABLE IF NOT EXISTS precios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL UNIQUE,
      sku_principal TEXT NOT NULL,
      nombre TEXT NOT NULL,
      precio REAL NOT NULL,
      actualizado_en TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_por TEXT,
      creado_en TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  console.log("Tabla precios lista.");

  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_precios_sku_principal ON precios(sku_principal)",
  );
  console.log("Índice idx_precios_sku_principal listo.");

  // Historial de cambios de precio — independiente del snapshot que guarda
  // cada renglón de remisión (ese vive en remision_renglones, nunca aquí).
  await client.execute(`
    CREATE TABLE IF NOT EXISTS precios_historial (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL,
      precio_anterior REAL,
      precio_nuevo REAL NOT NULL,
      usuario TEXT,
      creado_en TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  console.log("Tabla precios_historial lista.");

  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_precios_historial_sku ON precios_historial(sku)",
  );
  console.log("Índice idx_precios_historial_sku listo.");

  await client.execute(`
    CREATE TABLE IF NOT EXISTS remisiones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folio TEXT NOT NULL,
      fecha TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'interna',
      pedido_bodegas TEXT,
      cancelada INTEGER NOT NULL DEFAULT 0,
      subtotal REAL NOT NULL,
      descuento_pct REAL NOT NULL DEFAULT 0,
      descuento REAL NOT NULL,
      iva REAL NOT NULL,
      total REAL NOT NULL,
      precio_texto TEXT NOT NULL,
      usuario TEXT,
      creado_en TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  console.log("Tabla remisiones lista.");

  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_remisiones_fecha ON remisiones(fecha)",
  );
  console.log("Índice idx_remisiones_fecha listo.");

  await client.execute(`
    CREATE TABLE IF NOT EXISTS remision_renglones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      remision_id INTEGER NOT NULL REFERENCES remisiones(id),
      numero_renglon INTEGER NOT NULL,
      sku TEXT NOT NULL,
      producto_nombre TEXT NOT NULL,
      cantidad REAL NOT NULL,
      precio_unitario REAL NOT NULL,
      importe REAL NOT NULL
    )
  `);
  console.log("Tabla remision_renglones lista.");

  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_remision_renglones_remision ON remision_renglones(remision_id)",
  );
  console.log("Índice idx_remision_renglones_remision listo.");
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
