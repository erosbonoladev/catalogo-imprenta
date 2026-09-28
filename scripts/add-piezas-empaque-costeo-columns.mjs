// One-off migration: retira "Tipo de empaque" del formulario de Piezas (la
// columna `tipo_empaque` queda muerta — casi sin datos reales en producción,
// confirmado contra Turso el 2026-09-24: 1 de 2934 piezas la tenía cargada)
// y agrega 6 columnas nuevas, mismas que la hoja de trabajo "Para recetas"
// del negocio: Juegos por empaque, Costo por juego, Peso empaque, Volumen
// empaque, Precio por pieza, Precio por juego. Texto libre, mismo
// tratamiento que el resto de columnas de `plastic_products`
// (dimension/peso/coste/etc.) — ver src/components/PlasticProductFields.tsx,
// docs/DATABASE.md.
//
// Safe to run more than once (checks PRAGMA table_info first). Run with:
// node scripts/add-piezas-empaque-costeo-columns.mjs
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
  "juegos_por_empaque",
  "costo_por_juego",
  "peso_empaque",
  "volumen_empaque",
  "precio_por_pieza",
  "precio_por_juego",
];

async function main() {
  const info = await client.execute("PRAGMA table_info(plastic_products)");
  const existing = new Set(info.rows.map((row) => row.name));
  for (const column of COLUMNS) {
    if (existing.has(column)) {
      console.log(`plastic_products.${column} ya existe — nada que hacer.`);
      continue;
    }
    await client.execute(`ALTER TABLE plastic_products ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
    console.log(`Columna plastic_products.${column} agregada.`);
  }
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
