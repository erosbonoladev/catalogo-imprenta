import type { Client } from "@libsql/client/web";

export class AdminAuthError extends Error {}

/**
 * Espeja assertActorAuthorized()/loadActorSession() de src/db.ts (raíz del
 * repo) pero corre contra un token READ-ONLY de la base Turso principal —
 * este Worker nunca tiene el token de escritura de esa base. Mantener en
 * sync a mano si esa lógica cambia en src/db.ts: mismas columnas
 * (session_token/session_expires_at/activo/rol/user_permissions), mismo
 * criterio (rol admin pasa siempre; si no, exige el/los permiso(s)
 * indicados en user_permissions — "cualquiera de ellos" si es un array).
 */
export async function assertActorAuthorized(
  mainDb: Client,
  actor: { id: number; token: string },
  requiredPermiso: string | string[],
): Promise<string> {
  const result = await mainDb.execute({
    sql: `SELECT username, rol, activo FROM users
          WHERE id = ?1 AND session_token = ?2
            AND session_expires_at IS NOT NULL AND session_expires_at > datetime('now')`,
    args: [actor.id, actor.token],
  });
  const row = result.rows[0] as unknown as { username: string; rol: string; activo: number } | undefined;
  if (!row || !row.activo) {
    throw new AdminAuthError("No autorizado: la sesión no es válida o venció.");
  }
  if (row.rol === "admin") return row.username;

  const permisos = Array.isArray(requiredPermiso) ? requiredPermiso : [requiredPermiso];
  const placeholders = permisos.map((_, i) => `?${i + 2}`).join(", ");
  const permResult = await mainDb.execute({
    sql: `SELECT 1 FROM user_permissions WHERE user_id = ?1 AND permiso IN (${placeholders})`,
    args: [actor.id, ...permisos],
  });
  if (permResult.rows.length === 0) {
    throw new AdminAuthError("No autorizado: falta el permiso requerido para esta acción.");
  }
  return row.username;
}
