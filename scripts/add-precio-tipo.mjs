// One-off migration: adds a nullable `tipo` column ("interno"|"externo") to
// `precios` so productos guardados manualmente desde Remisiones puedan
// clasificarse (ver src/db.ts upsertPrecio). NULL = productos guardados antes
// de esta clasificación, tratados como "interno" por el resto de la app.
//
// Safe to run more than once (PRAGMA table_info check before the ALTER TABLE).
// Run with:
// node scripts/add-precio-tipo.mjs
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
  const info = await client.execute("PRAGMA table_info(precios)");
  const existing = new Set(info.rows.map((row) => row.name));
  if (existing.has("tipo")) {
    console.log("precios.tipo ya existe — nada que hacer.");
    return;
  }
  await client.execute("ALTER TABLE precios ADD COLUMN tipo TEXT");
  console.log("Columna precios.tipo agregada.");
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
