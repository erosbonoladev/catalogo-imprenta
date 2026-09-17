import { createClient, type Client } from "@libsql/client";

export const LICENSING_DB_PATH = "./.tmp/test-licensing.db";
export const MAIN_DB_PATH = "./.tmp/test-main.db";

let licensingClientInstance: Client | null = null;
let mainClientInstance: Client | null = null;

export function rawLicensingClient(): Client {
  if (!licensingClientInstance) {
    licensingClientInstance = createClient({ url: `file:${LICENSING_DB_PATH}`, intMode: "number" });
  }
  return licensingClientInstance;
}

export function rawMainClient(): Client {
  if (!mainClientInstance) {
    mainClientInstance = createClient({ url: `file:${MAIN_DB_PATH}`, intMode: "number" });
  }
  return mainClientInstance;
}

async function clearAllTables(client: Client): Promise<void> {
  const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  for (const row of tables.rows as unknown as { name: string }[]) {
    await client.execute(`DELETE FROM ${row.name}`);
  }
}

export async function resetDbs(): Promise<void> {
  await clearAllTables(rawLicensingClient());
  await clearAllTables(rawMainClient());
}

export interface FixtureActor {
  id: number;
  token: string;
}

/** Mismo criterio que createFixtureUser() en tests/helpers.ts (raíz del repo). */
export async function createFixtureActor(opts: {
  username: string;
  rol?: "usuario" | "admin";
  permisos?: string[];
  activo?: boolean;
  expired?: boolean;
}): Promise<FixtureActor> {
  const client = rawMainClient();
  const token = `test-token-${opts.username}-${Math.random().toString(36).slice(2)}`;
  const expiresExpr = opts.expired ? "datetime('now', '-1 hour')" : "datetime('now', '+12 hours')";
  const result = await client.execute({
    sql: `INSERT INTO users (username, password_hash, activo, rol, session_token, session_expires_at)
          VALUES (?1, 'x', ?2, ?3, ?4, ${expiresExpr})`,
    args: [opts.username, opts.activo === false ? 0 : 1, opts.rol ?? "usuario", token],
  });
  const id = Number(result.lastInsertRowid);
  for (const permiso of opts.permisos ?? []) {
    await client.execute({
      sql: "INSERT INTO user_permissions (user_id, permiso) VALUES (?1, ?2)",
      args: [id, permiso],
    });
  }
  return { id, token };
}
