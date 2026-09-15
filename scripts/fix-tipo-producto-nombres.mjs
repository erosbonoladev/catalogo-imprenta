// One-off migration: corrige en `products.tipo_producto` dos valores de
// TIPOS_PRODUCTO (src/types.ts) que se renombraron:
//   "Disfraces y vestuarios"         -> "Disfraces y vestuario"
//   "Números, Conteos y Operaciones" -> "Números, Conteo y operaciones"
// Solo actualiza filas que todavía tengan el valor viejo exacto — no toca
// ninguna otra columna ni tabla. Safe to run more than once (idempotente).
//
// Run with: node scripts/fix-tipo-producto-nombres.mjs
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

const RENAMES = [
  { from: "Disfraces y vestuarios", to: "Disfraces y vestuario" },
  { from: "Números, Conteos y Operaciones", to: "Números, Conteo y operaciones" },
];

async function main() {
  for (const { from, to } of RENAMES) {
    const result = await client.execute({
      sql: "UPDATE products SET tipo_producto = ? WHERE tipo_producto = ?",
      args: [to, from],
    });
    console.log(`"${from}" -> "${to}": ${result.rowsAffected} ficha(s) actualizada(s).`);
  }
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
