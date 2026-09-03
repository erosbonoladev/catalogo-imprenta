// One-off migration: adds users.backup_local_diario, used to let an admin
// flag a user so the app runs a local backup (once per day, per machine) on
// each entry — see src/auth.tsx and src/db.ts (runBackupNow).
//
// Safe to run more than once (checks PRAGMA table_info first). Run with:
// node scripts/add-backup-local-diario.mjs
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

  if (existing.has("backup_local_diario")) {
    console.log("users.backup_local_diario ya existe — nada que hacer.");
    return;
  }
  await client.execute(
    "ALTER TABLE users ADD COLUMN backup_local_diario INTEGER NOT NULL DEFAULT 0",
  );
  console.log("Columna users.backup_local_diario agregada.");
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
