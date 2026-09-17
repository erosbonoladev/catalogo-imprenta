import type { Client } from "@libsql/client/web";
import { generateActivationCode, generateDeviceToken, sha256Hex } from "./crypto";
import { recordAudit } from "./auditLog";
import type { CredentialRow, InstallationRow } from "../types";

export class CredentialError extends Error {}

export interface CreateCredentialInput {
  sede_codigo: string;
  sede_nombre: string;
  descripcion: string;
  usuario_responsable: string;
}

export async function createCredential(
  db: Client,
  input: CreateCredentialInput,
  creadoPor: string,
): Promise<{ credencial: CredentialRow; codigo: string }> {
  const sedeCodigo = input.sede_codigo.trim().toUpperCase();
  const sedeNombre = input.sede_nombre.trim();
  if (!sedeCodigo || !sedeNombre) {
    throw new CredentialError("Sede (código y nombre) es obligatoria.");
  }

  const codigo = generateActivationCode();
  const codeHash = await sha256Hex(codigo);
  const preview = codigo.slice(-4);

  const result = await db.execute({
    sql: `INSERT INTO installation_credentials
            (code_hash, code_preview, sede_codigo, sede_nombre, descripcion, usuario_responsable, creado_por)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
          RETURNING *`,
    args: [
      codeHash,
      preview,
      sedeCodigo,
      sedeNombre,
      input.descripcion.trim(),
      input.usuario_responsable.trim() || null,
      creadoPor,
    ],
  });
  const credencial = result.rows[0] as unknown as CredentialRow;
  await recordAudit(db, {
    accion: "credential_created",
    credential_id: credencial.id,
    actor_username: creadoPor,
    detalle: `Sede ${credencial.sede_codigo}`,
  });
  return { credencial, codigo };
}

// La credencial vieja queda revocada, no se borra — mismo criterio de "no
// eliminar datos" del resto del repo (ver docs/DATABASE.md, tablas
// insert-only/histórico). Crea una credencial nueva para la misma sede.
export async function regenerateCredential(
  db: Client,
  credentialId: number,
  actorUsername: string,
): Promise<{ credencial: CredentialRow; codigo: string }> {
  const existing = await db.execute({
    sql: "SELECT * FROM installation_credentials WHERE id = ?1",
    args: [credentialId],
  });
  const row = existing.rows[0] as unknown as CredentialRow | undefined;
  if (!row) throw new CredentialError("Credencial no encontrada.");

  await db.execute({
    sql: "UPDATE installation_credentials SET estado = 'revocada' WHERE id = ?1",
    args: [credentialId],
  });
  await recordAudit(db, {
    accion: "credential_regenerated",
    credential_id: credentialId,
    actor_username: actorUsername,
    detalle: `Reemplazada por una nueva para sede ${row.sede_codigo}`,
  });

  return createCredential(
    db,
    {
      sede_codigo: row.sede_codigo,
      sede_nombre: row.sede_nombre,
      descripcion: row.descripcion,
      usuario_responsable: row.usuario_responsable ?? "",
    },
    actorUsername,
  );
}

export async function activateCredential(
  db: Client,
  codigoPlano: string,
): Promise<{ installationId: number; installationCode: string; deviceToken: string; sedeNombre: string }> {
  const codigo = codigoPlano.trim();
  if (!codigo) throw new CredentialError("Código de activación inválido.");

  const codeHash = await sha256Hex(codigo);
  const result = await db.execute({
    sql: "SELECT * FROM installation_credentials WHERE code_hash = ?1",
    args: [codeHash],
  });
  const row = result.rows[0] as unknown as CredentialRow | undefined;

  if (!row) {
    await recordAudit(db, { accion: "activation_failed", detalle: "Código no encontrado" });
    throw new CredentialError("Código de activación inválido.");
  }
  if (row.estado !== "activa") {
    await recordAudit(db, { accion: "activation_failed", credential_id: row.id, detalle: "Credencial revocada" });
    throw new CredentialError("Esta credencial fue revocada.");
  }
  if (row.usado_en) {
    await recordAudit(db, { accion: "activation_failed", credential_id: row.id, detalle: "Credencial ya usada" });
    throw new CredentialError("Esta credencial ya fue usada para activar otra instalación.");
  }

  const deviceToken = generateDeviceToken();
  const deviceTokenHash = await sha256Hex(deviceToken);

  const tx = await db.transaction("write");
  try {
    // Mismo truco que insertFolioRow() en src/db.ts (raíz del repo):
    // consecutivo calculado con una subquery MAX+1 dentro del mismo
    // INSERT, sin un SELECT previo separado que abra ventana de carrera.
    const insertResult = await tx.execute({
      sql: `INSERT INTO installations
              (seq, sede_codigo, sede_nombre, descripcion, device_token_hash, installation_code)
            VALUES (
              (SELECT COALESCE(MAX(seq), 0) + 1 FROM installations WHERE sede_codigo = ?1),
              ?1, ?2, ?3, ?4, ''
            )
            RETURNING *`,
      args: [row.sede_codigo, row.sede_nombre, row.descripcion, deviceTokenHash],
    });
    const installation = insertResult.rows[0] as unknown as InstallationRow;
    const installationCode = `CLIO-${row.sede_codigo}-${String(installation.seq).padStart(4, "0")}`;

    await tx.execute({
      sql: "UPDATE installations SET installation_code = ?1 WHERE id = ?2",
      args: [installationCode, installation.id],
    });
    await tx.execute({
      sql: "UPDATE installation_credentials SET installation_id = ?1, usado_en = datetime('now') WHERE id = ?2",
      args: [installation.id, row.id],
    });
    await tx.execute({
      sql: `INSERT INTO audit_logs (accion, installation_id, credential_id, detalle)
            VALUES ('installation_activated', ?1, ?2, ?3)`,
      args: [installation.id, row.id, `Sede ${row.sede_codigo}`],
    });

    await tx.commit();
    return { installationId: installation.id, installationCode, deviceToken, sedeNombre: row.sede_nombre };
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}
