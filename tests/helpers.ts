import { createClient, type Client } from "@libsql/client";

/**
 * Conexión propia, independiente del cliente interno (privado, no
 * exportado) que abre src/db.ts — apunta al mismo archivo físico en disco,
 * usada para sembrar/inspeccionar filas directamente en las pruebas sin
 * tocar la superficie pública de db.ts.
 */
export const TEST_DB_PATH = "./.tmp/test.db";

let sharedClient: Client | null = null;

export function rawClient(): Client {
  if (!sharedClient) {
    sharedClient = createClient({ url: `file:${TEST_DB_PATH}` });
  }
  return sharedClient;
}

export async function resetDb(): Promise<void> {
  const client = rawClient();
  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  );
  for (const row of tables.rows as unknown as { name: string }[]) {
    await client.execute(`DELETE FROM ${row.name}`);
  }
}

export interface FixtureUser {
  id: number;
  token: string;
}

/** Usuario con una sesión ya "vigente" (o vencida/inactiva, según opts) — evita pasar por verifyLogin()/bcrypt en cada prueba. */
export async function createFixtureUser(opts: {
  username: string;
  rol?: "usuario" | "admin";
  permisos?: string[];
  activo?: boolean;
  expired?: boolean;
}): Promise<FixtureUser> {
  const client = rawClient();
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

export async function countRows(table: string, where?: string, args: unknown[] = []): Promise<number> {
  const client = rawClient();
  const sql = `SELECT COUNT(*) as n FROM ${table}${where ? ` WHERE ${where}` : ""}`;
  const result = await client.execute({ sql, args });
  return Number((result.rows[0] as unknown as { n: number }).n);
}
