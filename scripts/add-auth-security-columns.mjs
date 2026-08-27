// One-off migration: adds users.session_token, users.failed_attempts, and
// users.locked_until, used by the login-lockout + real session-token auth
// hardening (see src/db.ts verifyLogin/validateSession and src/auth.tsx).
//
// Safe to run more than once (checks PRAGMA table_info first per column). Run with:
// node scripts/add-auth-security-columns.mjs
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
  { name: "session_token", ddl: "ALTER TABLE users ADD COLUMN session_token TEXT" },
  {
    name: "failed_attempts",
    ddl: "ALTER TABLE users ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0",
  },
  { name: "locked_until", ddl: "ALTER TABLE users ADD COLUMN locked_until TEXT" },
];

async function main() {
  const info = await client.execute("PRAGMA table_info(users)");
  const existing = new Set(info.rows.map((row) => row.name));

  for (const column of COLUMNS) {
    if (existing.has(column.name)) {
      console.log(`users.${column.name} ya existe — nada que hacer.`);
      continue;
    }
    await client.execute(column.ddl);
    console.log(`Columna users.${column.name} agregada.`);
  }
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
