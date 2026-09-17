import type { Client } from "@libsql/client/web";
import { sha256Hex } from "./crypto";
import { recordAudit } from "./auditLog";
import type { InstallationRow } from "../types";

export class InstallationError extends Error {}

export async function listInstallations(db: Client): Promise<InstallationRow[]> {
  const result = await db.execute("SELECT * FROM installations ORDER BY activada_en DESC, id DESC");
  return result.rows as unknown as InstallationRow[];
}

export async function revokeInstallation(db: Client, id: number, actorUsername: string): Promise<void> {
  const result = await db.execute({
    sql: "UPDATE installations SET estado = 'revocada', revocada_en = datetime('now') WHERE id = ?1 AND estado = 'activa'",
    args: [id],
  });
  if (result.rowsAffected === 0) {
    throw new InstallationError("Instalación no encontrada o ya estaba revocada.");
  }
  await recordAudit(db, { accion: "installation_revoked", installation_id: id, actor_username: actorUsername });
}

export async function reactivateInstallation(db: Client, id: number, actorUsername: string): Promise<void> {
  const result = await db.execute({
    sql: "UPDATE installations SET estado = 'activa', reactivada_en = datetime('now') WHERE id = ?1 AND estado = 'revocada'",
    args: [id],
  });
  if (result.rowsAffected === 0) {
    throw new InstallationError("Instalación no encontrada o no estaba revocada.");
  }
  await recordAudit(db, { accion: "installation_reactivated", installation_id: id, actor_username: actorUsername });
}

// Heartbeat: valida el device token contra el hash guardado, refresca
// última conexión/versión reportada, y devuelve el estado real — es lo
// que alimenta la ventana de gracia offline del lado del cliente
// (ActivationProvider guarda `last_authorized_at` solo cuando esto
// devuelve authorized:true).
export async function checkInstallationStatus(
  db: Client,
  installationId: number,
  deviceToken: string,
  appVersion?: string,
): Promise<{ authorized: boolean; estado: string }> {
  const deviceTokenHash = await sha256Hex(deviceToken);
  const result = await db.execute({
    sql: "SELECT * FROM installations WHERE id = ?1 AND device_token_hash = ?2",
    args: [installationId, deviceTokenHash],
  });
  const row = result.rows[0] as unknown as InstallationRow | undefined;
  if (!row) {
    return { authorized: false, estado: "no_encontrada" };
  }
  await db.execute({
    sql: `UPDATE installations
          SET ultima_conexion_en = datetime('now'), ultima_version = COALESCE(?1, ultima_version)
          WHERE id = ?2`,
    args: [appVersion ?? null, row.id],
  });
  return { authorized: row.estado === "activa", estado: row.estado };
}
