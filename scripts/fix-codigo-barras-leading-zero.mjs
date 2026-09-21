// One-off migration: agrega un "0" al principio de `products.codigo_barras_texto`
// en todas las fichas cuyo código de barras es puramente numérico (pedido
// explícito del negocio, 2026-09-21). Excluye a propósito los valores no
// numéricos como "Pendiente" (código todavía no asignado) — a esos no se les
// toca nada. No es idempotente: correrlo dos veces agregaría un segundo "0".
//
// Antes de escribir, vuelca a un JSON local el estado "antes" de cada fila
// que va a tocar (id, codigo, codigo_barras_texto), para poder revertir a
// mano si hiciera falta (no hay backup automático disponible desde un script
// de Node suelto, fuera del runtime de la app).
//
// Run with: node scripts/fix-codigo-barras-leading-zero.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// Solo dígitos, no vacío — así "Pendiente" y cualquier otro valor no
// numérico quedan afuera sin tener que listarlos a mano.
const WHERE_NUMERIC =
  "codigo_barras_texto IS NOT NULL AND codigo_barras_texto != '' AND codigo_barras_texto NOT GLOB '*[^0-9]*'";

async function main() {
  const before = await client.execute(
    `SELECT id, codigo, codigo_barras_texto FROM products WHERE ${WHERE_NUMERIC}`,
  );
  const tmpDir = join(rootDir, ".tmp");
  mkdirSync(tmpDir, { recursive: true });
  const backupPath = join(tmpDir, `codigo-barras-antes-de-fix-${Date.now()}.json`);
  writeFileSync(backupPath, JSON.stringify(before.rows, null, 2));
  console.log(`Respaldo de ${before.rows.length} fila(s) guardado en ${backupPath}`);

  const result = await client.execute(
    `UPDATE products SET codigo_barras_texto = '0' || codigo_barras_texto WHERE ${WHERE_NUMERIC}`,
  );
  console.log(`${result.rowsAffected} ficha(s) actualizada(s) con "0" al principio de su código de barras.`);
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
