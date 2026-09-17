import { beforeEach, describe, expect, it } from "vitest";
import { assertActorAuthorized, AdminAuthError } from "../src/logic/adminAuth";
import { rawMainClient, createFixtureActor, resetDbs } from "./helpers";

beforeEach(async () => {
  await resetDbs();
});

describe("assertActorAuthorized (espejo de assertActorAuthorized en src/db.ts)", () => {
  it("rechaza un token que no existe", async () => {
    const db = rawMainClient();
    await expect(
      assertActorAuthorized(db, { id: 999999, token: "nope" }, "instalaciones_ver"),
    ).rejects.toThrow(AdminAuthError);
  });

  it("rechaza una sesión vencida", async () => {
    const db = rawMainClient();
    const actor = await createFixtureActor({ username: "vencido", expired: true, permisos: ["instalaciones_ver"] });
    await expect(assertActorAuthorized(db, actor, "instalaciones_ver")).rejects.toThrow(/no es válida o venció/i);
  });

  it("rechaza un usuario inactivo aunque el token sea correcto", async () => {
    const db = rawMainClient();
    const actor = await createFixtureActor({ username: "inactivo", activo: false, permisos: ["instalaciones_ver"] });
    await expect(assertActorAuthorized(db, actor, "instalaciones_ver")).rejects.toThrow(AdminAuthError);
  });

  it("rechaza a un usuario sin el permiso requerido", async () => {
    const db = rawMainClient();
    const actor = await createFixtureActor({ username: "sinpermiso", permisos: [] });
    await expect(assertActorAuthorized(db, actor, "instalaciones_ver")).rejects.toThrow(/falta el permiso/i);
  });

  it("acepta a un usuario con el permiso exacto", async () => {
    const db = rawMainClient();
    const actor = await createFixtureActor({ username: "conpermiso", permisos: ["instalaciones_ver"] });
    await expect(assertActorAuthorized(db, actor, "instalaciones_ver")).resolves.toBe("conpermiso");
  });

  it("acepta con cualquiera de varios permisos", async () => {
    const db = rawMainClient();
    const actor = await createFixtureActor({ username: "revocador", permisos: ["instalaciones_revocar"] });
    await expect(
      assertActorAuthorized(db, actor, ["instalaciones_revocar", "instalaciones_reactivar"]),
    ).resolves.toBe("revocador");
  });

  it("un admin pasa sin permisos otorgados explícitamente", async () => {
    const db = rawMainClient();
    const actor = await createFixtureActor({ username: "admin1", rol: "admin", permisos: [] });
    await expect(assertActorAuthorized(db, actor, "instalaciones_crear_credenciales")).resolves.toBe("admin1");
  });
});
