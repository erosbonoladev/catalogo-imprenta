// One-off migration: adds users.admin_session_token and
// users.admin_session_expires_at so the Administrativo app keeps its own
// session, independent from Clio's (session_token/session_expires_at).
// Before this, both apps shared one token per user and logging into one
// closed the other.
//
// Safe to run more than once (PRAGMA table_info check per column). Existing
// rows get NULL, so Administrativo users just log in once more. Run with:
// node scripts/add-admin-session-columns.mjs
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
  { name: "admin_session_token", ddl: "ALTER TABLE users ADD COLUMN admin_session_token TEXT" },
  { name: "admin_session_expires_at", ddl: "ALTER TABLE users ADD COLUMN admin_session_expires_at TEXT" },
];

async function main() {
  const info = await client.execute("PRAGMA table_info(users)");
  const existing = new Set(info.rows.map((row) => row.name));
  for (const col of COLUMNS) {
    if (existing.has(col.name)) {
      console.log(`users.${col.name} ya existe — nada que hacer.`);
      continue;
    }
    await client.execute(col.ddl);
    console.log(`Columna users.${col.name} agregada.`);
  }
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
