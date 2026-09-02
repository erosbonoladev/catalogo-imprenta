// One-off migration: adds a nullable `session_expires_at` column to `users`
// so sessions carry a real expiration instead of living forever until a
// password change or explicit logout (see src/db.ts verifyLogin/validateSession).
//
// Safe to run more than once (PRAGMA table_info check before the ALTER TABLE).
// Does not touch existing rows — sessions issued before this migration simply
// have session_expires_at = NULL and are treated as already-expired on the
// next validateSession() call, forcing a normal re-login.
// Run with:
// node scripts/add-session-expiry.mjs
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
  const info = await client.execute("PRAGMA table_info(users)");
  const existing = new Set(info.rows.map((row) => row.name));
  if (existing.has("session_expires_at")) {
    console.log("users.session_expires_at ya existe — nada que hacer.");
    return;
  }
  await client.execute("ALTER TABLE users ADD COLUMN session_expires_at TEXT");
  console.log("Columna users.session_expires_at agregada.");
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
