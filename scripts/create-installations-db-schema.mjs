// One-off migration: crea el esquema completo (`installation_credentials`,
// `installations`, `audit_logs`) en la base Turso de LICENCIAMIENTO — una
// base separada de la principal (VITE_TURSO_URL) a propósito, ver
// docs/DISTRIBUTION.md. El Update API (update-api/) es el único
// consumidor: CLIO nunca se conecta a esta base directamente, ni su
// bundle lleva ningún token con acceso a ella.
//
// Lee las credenciales desde INSTALLATIONS_TURSO_URL/INSTALLATIONS_TURSO_TOKEN
// en el .env de la raíz del repo (mismas variables que después se cargan
// como secrets del Worker con `wrangler secret put`, ver update-api/wrangler.toml)
// — nunca desde VITE_TURSO_URL/VITE_TURSO_AUTH_TOKEN, que son la base
// principal.
//
// Safe to run more than once (CREATE TABLE IF NOT EXISTS). Run with:
// node scripts/create-installations-db-schema.mjs
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
if (!env.INSTALLATIONS_TURSO_URL || !env.INSTALLATIONS_TURSO_TOKEN) {
  console.error(
    "Faltan INSTALLATIONS_TURSO_URL/INSTALLATIONS_TURSO_TOKEN en .env — crear la base de licenciamiento primero (ver docs/DISTRIBUTION.md) y agregar sus credenciales ahí.",
  );
  process.exit(1);
}

const client = createClient({
  url: env.INSTALLATIONS_TURSO_URL,
  authToken: env.INSTALLATIONS_TURSO_TOKEN,
});

async function main() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS installation_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code_hash TEXT NOT NULL UNIQUE,
      code_preview TEXT NOT NULL,
      sede_codigo TEXT NOT NULL,
      sede_nombre TEXT NOT NULL,
      descripcion TEXT NOT NULL DEFAULT '',
      usuario_responsable TEXT,
      estado TEXT NOT NULL DEFAULT 'activa',
      installation_id INTEGER,
      creado_por TEXT NOT NULL,
      creado_en TEXT NOT NULL DEFAULT (datetime('now')),
      usado_en TEXT
    )
  `);
  console.log("Tabla installation_credentials lista.");

  await client.execute(`
    CREATE TABLE IF NOT EXISTS installations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      installation_code TEXT NOT NULL UNIQUE,
      seq INTEGER NOT NULL,
      sede_codigo TEXT NOT NULL,
      sede_nombre TEXT NOT NULL,
      descripcion TEXT NOT NULL DEFAULT '',
      device_token_hash TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'activa',
      ultima_version TEXT,
      ultima_conexion_en TEXT,
      activada_en TEXT NOT NULL DEFAULT (datetime('now')),
      revocada_en TEXT,
      reactivada_en TEXT
    )
  `);
  console.log("Tabla installations lista.");

  await client.execute(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      accion TEXT NOT NULL,
      installation_id INTEGER,
      credential_id INTEGER,
      actor_username TEXT,
      detalle TEXT NOT NULL DEFAULT '',
      creado_en TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  console.log("Tabla audit_logs lista.");

  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_installations_sede_seq ON installations(sede_codigo, seq)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_installation_credentials_estado ON installation_credentials(estado)",
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
