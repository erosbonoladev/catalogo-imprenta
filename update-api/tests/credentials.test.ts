import { beforeEach, describe, expect, it } from "vitest";
import { createCredential, activateCredential, regenerateCredential, CredentialError } from "../src/logic/credentials";
import { rawLicensingClient, resetDbs } from "./helpers";

const baseInput = {
  sede_codigo: "pue",
  sede_nombre: "Puebla",
  descripcion: "Sucursal centro",
  usuario_responsable: "Juan",
};

beforeEach(async () => {
  await resetDbs();
});

describe("createCredential", () => {
  it("genera un código de 256 bits y solo guarda su hash", async () => {
    const db = rawLicensingClient();
    const { credencial, codigo } = await createCredential(db, baseInput, "admin1");
    expect(codigo).toMatch(/^CLIO-/);
    expect(credencial.code_preview).toBe(codigo.slice(-4));
    expect(credencial.sede_codigo).toBe("PUE");
    expect(credencial.estado).toBe("activa");
    expect(credencial.creado_por).toBe("admin1");

    const row = await db.execute({ sql: "SELECT code_hash FROM installation_credentials WHERE id = ?1", args: [credencial.id] });
    const hash = (row.rows[0] as unknown as { code_hash: string }).code_hash;
    expect(hash).not.toBe(codigo);
    expect(hash).toHaveLength(64); // sha256 hex
  });

  it("rechaza sin sede", async () => {
    const db = rawLicensingClient();
    await expect(createCredential(db, { ...baseInput, sede_codigo: "" }, "admin1")).rejects.toThrow(CredentialError);
  });
});

describe("activateCredential", () => {
  it("activa con un código válido y genera un installation_code consecutivo por sede", async () => {
    const db = rawLicensingClient();
    const { codigo: codigo1 } = await createCredential(db, baseInput, "admin1");
    const { codigo: codigo2 } = await createCredential(db, baseInput, "admin1");

    const first = await activateCredential(db, codigo1);
    const second = await activateCredential(db, codigo2);

    expect(first.installationCode).toBe("CLIO-PUE-0001");
    expect(second.installationCode).toBe("CLIO-PUE-0002");
    expect(first.deviceToken).not.toBe(second.deviceToken);
  });

  it("numera independientemente por sede", async () => {
    const db = rawLicensingClient();
    const { codigo: cdmxCodigo } = await createCredential(db, { ...baseInput, sede_codigo: "cdmx", sede_nombre: "CDMX" }, "admin1");
    const { codigo: pueCodigo } = await createCredential(db, baseInput, "admin1");

    const cdmx = await activateCredential(db, cdmxCodigo);
    const pue = await activateCredential(db, pueCodigo);

    expect(cdmx.installationCode).toBe("CLIO-CDMX-0001");
    expect(pue.installationCode).toBe("CLIO-PUE-0001");
  });

  it("rechaza un código inexistente", async () => {
    const db = rawLicensingClient();
    await expect(activateCredential(db, "CLIO-NOPE-NOPE")).rejects.toThrow(/inválido/i);
  });

  it("rechaza una credencial revocada", async () => {
    const db = rawLicensingClient();
    const { credencial, codigo } = await createCredential(db, baseInput, "admin1");
    await db.execute({ sql: "UPDATE installation_credentials SET estado = 'revocada' WHERE id = ?1", args: [credencial.id] });
    await expect(activateCredential(db, codigo)).rejects.toThrow(/revocada/i);
  });

  it("rechaza la reutilización de un código ya activado", async () => {
    const db = rawLicensingClient();
    const { codigo } = await createCredential(db, baseInput, "admin1");
    await activateCredential(db, codigo);
    await expect(activateCredential(db, codigo)).rejects.toThrow(/ya fue usada/i);
  });
});

describe("regenerateCredential", () => {
  it("revoca la vieja y crea una nueva para la misma sede", async () => {
    const db = rawLicensingClient();
    const { credencial } = await createCredential(db, baseInput, "admin1");
    const { credencial: nueva, codigo: nuevoCodigo } = await regenerateCredential(db, credencial.id, "admin2");

    expect(nueva.id).not.toBe(credencial.id);
    expect(nueva.sede_codigo).toBe("PUE");
    expect(nueva.creado_por).toBe("admin2");

    const oldRow = await db.execute({ sql: "SELECT estado FROM installation_credentials WHERE id = ?1", args: [credencial.id] });
    expect((oldRow.rows[0] as unknown as { estado: string }).estado).toBe("revocada");

    // La nueva funciona
    const activated = await activateCredential(db, nuevoCodigo);
    expect(activated.installationCode).toBe("CLIO-PUE-0001");
  });

  it("rechaza una credencial inexistente", async () => {
    const db = rawLicensingClient();
    await expect(regenerateCredential(db, 999999, "admin1")).rejects.toThrow(CredentialError);
  });
});
