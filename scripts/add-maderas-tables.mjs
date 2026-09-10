// One-off migration: crea las tablas de la nueva sección "Maderas"
// (src/components/MaderasSection.tsx / MaderaImportPanel.tsx) — mismo
// patrón que Piezas (plastic_products/product_plastic_items/
// piezas_import_batches), pero con su propio esquema porque las columnas de
// Maderas (Tamaño, Capas, Largo, Ancho, Espesor, aprovechamiento de hoja de
// MDF, minutos en láser, importes, Otro+concepto, costo total, precio
// venta) no corresponden a ningún campo de plastic_products.
//
// wood_products: catálogo maestro de productos de madera.
// product_wood_items: relación ficha (products) <-> producto de madera,
//   igual que product_plastic_items.
// madera_import_batches: registra qué productos de madera CREÓ la última
//   corrida de importación masiva, para poder deshacerla — igual que
//   piezas_import_batches.
//
// Puramente aditivo — no toca ninguna tabla ni dato existente. Safe to run
// more than once (CREATE TABLE IF NOT EXISTS). Run with:
// node scripts/add-maderas-tables.mjs
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
    CREATE TABLE IF NOT EXISTS wood_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      sku TEXT,
      tamano TEXT,
      capas TEXT,
      largo TEXT,
      ancho TEXT,
      espesor TEXT,
      caben_hoja_mdf TEXT,
      minutos_laser TEXT,
      importe_madera REAL,
      pintura REAL,
      importe_corte_laser REAL,
      etiqueta_adhesiva REAL,
      otro_importe REAL,
      otro_concepto TEXT,
      etiqueta_empaque REAL,
      costo_total REAL,
      precio_venta REAL,
      creado_en TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  console.log("Tabla wood_products lista.");

  await client.execute(`
    CREATE TABLE IF NOT EXISTS product_wood_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      wood_product_id INTEGER NOT NULL,
      orden INTEGER NOT NULL DEFAULT 1
    )
  `);
  console.log("Tabla product_wood_items lista.");

  await client.execute(`
    CREATE TABLE IF NOT EXISTS madera_import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creado_en TEXT NOT NULL DEFAULT (datetime('now')),
      creado_por TEXT,
      wood_product_ids TEXT NOT NULL,
      total INTEGER NOT NULL,
      deshecho_en TEXT
    )
  `);
  console.log("Tabla madera_import_batches lista.");
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
