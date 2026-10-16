// One-off migration: datos del cliente de las remisiones EXTERNAS.
// Agrega a `remisiones` cliente_rfc, cliente_direccion, cliente_contacto y
// cliente_telefono (TEXT, NULL). El nombre del cliente ya vive en
// `pedido_bodegas`. Las remisiones internas y las existentes quedan en NULL.
//
// Correr ANTES de que los usuarios generen remisiones externas con la versión
// nueva de la app (las internas no dependen de estas columnas).
// Safe to run more than once (revisa PRAGMA table_info). Run with:
// node scripts/add-remisiones-cliente-externo-columns.mjs
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

const COLUMNS = ["cliente_rfc", "cliente_direccion", "cliente_contacto", "cliente_telefono"];

async function main() {
  const info = await client.execute("PRAGMA table_info(remisiones)");
  const existing = new Set(info.rows.map((row) => row.name));
  let added = 0;
  for (const column of COLUMNS) {
    if (existing.has(column)) continue;
    await client.execute(`ALTER TABLE remisiones ADD COLUMN ${column} TEXT`);
    console.log(`Columna remisiones.${column} agregada.`);
    added++;
  }
  if (added === 0) console.log("Las columnas cliente_* ya existen — nada que hacer.");
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
