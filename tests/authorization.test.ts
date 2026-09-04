import { beforeEach, describe, expect, it } from "vitest";
import { createProduct, updatePrecio, upsertPrecio, updateUser } from "../src/db";
import { createFixtureUser, rawClient, resetDb } from "./helpers";

// updateUser()/createUser() sin `password` no pasan por el comando Tauri
// hash_password (invoke), que no existe fuera del runtime real de la app —
// se usa updateUser() sin password para poder ejercer la rama "requiere
// admin" de assertActorAuthorized sin necesitar ese puente nativo.
const noopPermUpdate = { activo: true, rol: "usuario" as const, permisos: [], backup_local_diario: false };

const emptyProduct = {
  codigo: "SKU-AUTH",
  nombre: "Producto de prueba",
  categoria: "",
  material: "",
  descripcion: "",
  imagen: null,
  imagen_codigo_barras: null,
};

beforeEach(async () => {
  await resetDb();
});

describe("assertActorSession (catálogo base — cualquier sesión vigente)", () => {
  it("rechaza un token que no existe", async () => {
    await expect(
      createProduct({ id: 999999, token: "nope" }, emptyProduct, []),
    ).rejects.toThrow(/no autorizado/i);
  });

  it("rechaza una sesión vencida", async () => {
    const user = await createFixtureUser({ username: "vencido", expired: true });
    await expect(createProduct(user, emptyProduct, [])).rejects.toThrow(/no autorizado/i);
  });

  it("rechaza un usuario inactivo aunque el token sea correcto", async () => {
    const user = await createFixtureUser({ username: "inactivo", activo: false });
    await expect(createProduct(user, emptyProduct, [])).rejects.toThrow(/no autorizado/i);
  });

  it("acepta cualquier usuario autenticado, sin permiso específico", async () => {
    const user = await createFixtureUser({ username: "cualquiera", permisos: [] });
    await expect(createProduct(user, emptyProduct, [])).resolves.toEqual(expect.any(Number));
  });
});

describe("assertActorAuthorized con un solo permiso (updatePrecio → precios_modificar)", () => {
  async function seedPrecio(sku: string): Promise<number> {
    const result = await rawClient().execute({
      sql: "INSERT INTO precios (sku, sku_principal, nombre, precio) VALUES (?1, ?1, 'Original', 10)",
      args: [sku],
    });
    return Number(result.lastInsertRowid);
  }

  it("rechaza a un usuario sin el permiso", async () => {
    const id = await seedPrecio("X0");
    const user = await createFixtureUser({ username: "sinpermiso", permisos: [] });
    await expect(
      updatePrecio(user, id, { sku: "X0", nombre: "X", precio: 1, usuario: null }),
    ).rejects.toThrow(/no autorizado/i);
  });

  it("acepta a un usuario con el permiso exacto", async () => {
    const id = await seedPrecio("X1");
    const user = await createFixtureUser({ username: "conpermiso", permisos: ["precios_modificar"] });
    await expect(
      updatePrecio(user, id, { sku: "X1", nombre: "Editado", precio: 5, usuario: null }),
    ).resolves.toMatchObject({ sku: "X1", nombre: "Editado", precio: 5 });
  });

  it("un admin pasa sin tener el permiso otorgado explícitamente", async () => {
    const id = await seedPrecio("X2");
    const admin = await createFixtureUser({ username: "admin1", rol: "admin", permisos: [] });
    await expect(
      updatePrecio(admin, id, { sku: "X2", nombre: "Editado admin", precio: 7, usuario: null }),
    ).resolves.toMatchObject({ sku: "X2", nombre: "Editado admin", precio: 7 });
  });
});

describe("assertActorAuthorized sin permiso indicado (updateUser → solo admin)", () => {
  it("rechaza a un usuario no-admin aunque tenga sesión vigente", async () => {
    const user = await createFixtureUser({ username: "nootroadmin", permisos: [] });
    const target = await createFixtureUser({ username: "objetivo1" });
    await expect(
      updateUser(user, target.id, { username: "objetivo1", ...noopPermUpdate }),
    ).rejects.toThrow(/cuenta administradora/i);
  });

  it("acepta a un admin", async () => {
    const admin = await createFixtureUser({ username: "admin2", rol: "admin" });
    const target = await createFixtureUser({ username: "objetivo2" });
    await expect(
      updateUser(admin, target.id, { username: "objetivo2", ...noopPermUpdate }),
    ).resolves.toBeUndefined();
  });
});

describe("assertActorAuthorized con lista de permisos (upsertPrecio → precios_modificar O remisiones_crear)", () => {
  it("rechaza a un usuario sin ninguno de los dos permisos", async () => {
    const user = await createFixtureUser({ username: "ninguno", permisos: ["plasticos"] });
    await expect(
      upsertPrecio(user, { sku: "Y", nombre: "Y", precio: 1, usuario: null }),
    ).rejects.toThrow(/no autorizado/i);
  });

  it("acepta con precios_modificar solamente", async () => {
    const user = await createFixtureUser({ username: "soloprecios", permisos: ["precios_modificar"] });
    await expect(
      upsertPrecio(user, { sku: "Y1", nombre: "Y1", precio: 1, usuario: null }),
    ).resolves.toMatchObject({ sku: "Y1" });
  });

  it("acepta con remisiones_crear solamente (flujo 'Guardar producto' de RemisionForm)", async () => {
    const user = await createFixtureUser({ username: "soloremisiones", permisos: ["remisiones_crear"] });
    await expect(
      upsertPrecio(user, { sku: "Y2", nombre: "Y2", precio: 1, usuario: null }),
    ).resolves.toMatchObject({ sku: "Y2" });
  });
});
