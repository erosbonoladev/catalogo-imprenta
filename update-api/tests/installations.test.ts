import { beforeEach, describe, expect, it } from "vitest";
import { createCredential, activateCredential } from "../src/logic/credentials";
import {
  listInstallations,
  revokeInstallation,
  reactivateInstallation,
  checkInstallationStatus,
  InstallationError,
} from "../src/logic/installations";
import { rawLicensingClient, resetDbs } from "./helpers";

const baseInput = { sede_codigo: "PUE", sede_nombre: "Puebla", descripcion: "", usuario_responsable: "" };

beforeEach(async () => {
  await resetDbs();
});

async function activatedInstallation() {
  const db = rawLicensingClient();
  const { codigo } = await createCredential(db, baseInput, "admin1");
  return activateCredential(db, codigo);
}

describe("checkInstallationStatus (heartbeat)", () => {
  it("autoriza con el device token correcto", async () => {
    const db = rawLicensingClient();
    const { installationId, deviceToken } = await activatedInstallation();
    const status = await checkInstallationStatus(db, installationId, deviceToken, "0.16.0");
    expect(status).toEqual({ authorized: true, estado: "activa" });

    const row = await db.execute({ sql: "SELECT ultima_version FROM installations WHERE id = ?1", args: [installationId] });
    expect((row.rows[0] as unknown as { ultima_version: string }).ultima_version).toBe("0.16.0");
  });

  it("rechaza un device token incorrecto", async () => {
    const db = rawLicensingClient();
    const { installationId } = await activatedInstallation();
    const status = await checkInstallationStatus(db, installationId, "token-que-no-es");
    expect(status.authorized).toBe(false);
    expect(status.estado).toBe("no_encontrada");
  });

  it("reporta revocada sin autorizar, sin borrar nada", async () => {
    const db = rawLicensingClient();
    const { installationId, deviceToken } = await activatedInstallation();
    await revokeInstallation(db, installationId, "admin1");
    const status = await checkInstallationStatus(db, installationId, deviceToken);
    expect(status).toEqual({ authorized: false, estado: "revocada" });

    const row = await db.execute({ sql: "SELECT * FROM installations WHERE id = ?1", args: [installationId] });
    expect(row.rows).toHaveLength(1); // sigue existiendo, no se borró
  });
});

describe("revokeInstallation / reactivateInstallation", () => {
  it("revoca y luego reactiva", async () => {
    const db = rawLicensingClient();
    const { installationId, deviceToken } = await activatedInstallation();

    await revokeInstallation(db, installationId, "admin1");
    expect((await checkInstallationStatus(db, installationId, deviceToken)).estado).toBe("revocada");

    await reactivateInstallation(db, installationId, "admin1");
    expect((await checkInstallationStatus(db, installationId, deviceToken)).authorized).toBe(true);
  });

  it("rechaza revocar una instalación inexistente", async () => {
    const db = rawLicensingClient();
    await expect(revokeInstallation(db, 999999, "admin1")).rejects.toThrow(InstallationError);
  });

  it("rechaza reactivar una instalación que no estaba revocada", async () => {
    const db = rawLicensingClient();
    const { installationId } = await activatedInstallation();
    await expect(reactivateInstallation(db, installationId, "admin1")).rejects.toThrow(InstallationError);
  });
});

describe("listInstallations", () => {
  it("lista las instalaciones más recientes primero", async () => {
    const db = rawLicensingClient();
    await activatedInstallation();
    await activatedInstallation();
    const list = await listInstallations(db);
    expect(list).toHaveLength(2);
    expect(list[0].id).toBeGreaterThan(list[1].id);
  });
});
