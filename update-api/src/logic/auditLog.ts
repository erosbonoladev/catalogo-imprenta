import type { Client } from "@libsql/client/web";

export interface AuditInput {
  accion: string;
  installation_id?: number;
  credential_id?: number;
  actor_username?: string;
  detalle?: string;
}

// Best-effort, mismo criterio que logEvent()/logEventAsActor() en
// src/db.ts (raíz del repo) — un fallo al auditar nunca debe tumbar la
// acción real que se está auditando.
export async function recordAudit(db: Client, input: AuditInput): Promise<void> {
  try {
    await db.execute({
      sql: `INSERT INTO audit_logs (accion, installation_id, credential_id, actor_username, detalle)
            VALUES (?1, ?2, ?3, ?4, ?5)`,
      args: [
        input.accion,
        input.installation_id ?? null,
        input.credential_id ?? null,
        input.actor_username ?? null,
        input.detalle ?? "",
      ],
    });
  } catch {
    // best-effort, ver arriba
  }
}
