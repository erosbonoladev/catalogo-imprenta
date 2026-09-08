import { beforeEach, describe, expect, it } from "vitest";
import {
  clearLogs,
  clearSession,
  createProduct,
  createRemisionConFolio,
  createRequisicionConFolio,
  getBackupSettings,
  getRecentLogs,
  getRemisionRenglones,
  listBackupHistory,
  listRemisiones,
  listRemisionRenglonesParaHistorial,
  logEvent,
  logEventAsActor,
  recordBackupSettingsChange,
  recordRestoreResult,
  setPresentacionOriginal,
  updatePlasticProductSku,
  updatePrecio,
  updateProductImage,
  upsertPrecio,
  updateUser,
  validateSession,
} from "../src/db";
import { countRows, createFixtureUser, rawClient, resetDb } from "./helpers";

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
      updatePrecio(user, id, { sku: "X0", nombre: "X", precio: 1 }),
    ).rejects.toThrow(/no autorizado/i);
  });

  it("acepta a un usuario con el permiso exacto", async () => {
    const id = await seedPrecio("X1");
    const user = await createFixtureUser({ username: "conpermiso", permisos: ["precios_modificar"] });
    await expect(
      updatePrecio(user, id, { sku: "X1", nombre: "Editado", precio: 5 }),
    ).resolves.toMatchObject({ sku: "X1", nombre: "Editado", precio: 5 });
  });

  it("un admin pasa sin tener el permiso otorgado explícitamente", async () => {
    const id = await seedPrecio("X2");
    const admin = await createFixtureUser({ username: "admin1", rol: "admin", permisos: [] });
    await expect(
      updatePrecio(admin, id, { sku: "X2", nombre: "Editado admin", precio: 7 }),
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

describe("clearSession — cierra por id+token, nunca pisa una sesión más nueva del mismo usuario", () => {
  it("invalida la sesión cuando el token coincide", async () => {
    const user = await createFixtureUser({ username: "cierre_normal" });
    await expect(validateSession(user.id, user.token)).resolves.not.toBeNull();

    await clearSession(user.id, user.token);

    await expect(validateSession(user.id, user.token)).resolves.toBeNull();
  });

  it("un logout con un token viejo no invalida una sesión más nueva del mismo usuario (p. ej. logueado después en otro dispositivo)", async () => {
    const user = await createFixtureUser({ username: "dos_sesiones" });
    const tokenViejo = user.token;

    // Simula un login posterior en otro dispositivo: se genera un token
    // nuevo para el mismo usuario (mismo criterio que verifyLogin, que
    // sobrescribe session_token en cada login exitoso).
    const tokenNuevo = "token-sesion-nueva";
    await rawClient().execute({
      sql: "UPDATE users SET session_token = ?1, session_expires_at = datetime('now', '+12 hours') WHERE id = ?2",
      args: [tokenNuevo, user.id],
    });

    // Un logout que todavía trae el token viejo en memoria (pestaña atrasada,
    // proceso zombie, etc.) no debe cerrar la sesión nueva.
    await clearSession(user.id, tokenViejo);

    await expect(validateSession(user.id, tokenNuevo)).resolves.not.toBeNull();
  });
});

describe("updateUser — protección server-side del último administrador activo", () => {
  it("rechaza degradar de rol al único admin activo, y no deja ningún cambio aplicado (transaccional)", async () => {
    const unico = await createFixtureUser({ username: "unico_admin", rol: "admin" });
    await expect(
      updateUser(unico, unico.id, { username: "unico_admin", activo: true, rol: "usuario", permisos: [], backup_local_diario: false }),
    ).rejects.toThrow(/al menos un administrador activo/i);

    const row = await rawClient().execute({ sql: "SELECT rol, activo FROM users WHERE id = ?1", args: [unico.id] });
    expect(row.rows[0]).toMatchObject({ rol: "admin", activo: 1 });
  });

  it("rechaza desactivar (activo=false) al único admin activo, aunque el rol siga siendo admin", async () => {
    const unico = await createFixtureUser({ username: "unico_admin2", rol: "admin" });
    await expect(
      updateUser(unico, unico.id, { username: "unico_admin2", activo: false, rol: "admin", permisos: [], backup_local_diario: false }),
    ).rejects.toThrow(/al menos un administrador activo/i);
  });

  it("permite degradar a un admin si queda al menos otro admin activo", async () => {
    const admin1 = await createFixtureUser({ username: "admin_a", rol: "admin" });
    const admin2 = await createFixtureUser({ username: "admin_b", rol: "admin" });
    await expect(
      updateUser(admin1, admin2.id, { username: "admin_b", activo: true, rol: "usuario", permisos: [], backup_local_diario: false }),
    ).resolves.toBeUndefined();

    const row = await rawClient().execute({ sql: "SELECT rol FROM users WHERE id = ?1", args: [admin2.id] });
    expect(row.rows[0].rol).toBe("usuario");
  });

  it("un admin inactivo/no-admin existente no cuenta como 'otro admin activo' disponible", async () => {
    const activo = await createFixtureUser({ username: "admin_activo", rol: "admin" });
    await createFixtureUser({ username: "admin_inactivo", rol: "admin", activo: false });
    await expect(
      updateUser(activo, activo.id, { username: "admin_activo", activo: true, rol: "usuario", permisos: [], backup_local_diario: false }),
    ).rejects.toThrow(/al menos un administrador activo/i);
  });
});

describe("assertActorAuthorized con lista de permisos (upsertPrecio → precios_modificar O remisiones_crear)", () => {
  it("rechaza a un usuario sin ninguno de los dos permisos", async () => {
    const user = await createFixtureUser({ username: "ninguno", permisos: ["plasticos"] });
    await expect(
      upsertPrecio(user, { sku: "Y", nombre: "Y", precio: 1 }),
    ).rejects.toThrow(/no autorizado/i);
  });

  it("acepta con precios_modificar solamente", async () => {
    const user = await createFixtureUser({ username: "soloprecios", permisos: ["precios_modificar"] });
    await expect(
      upsertPrecio(user, { sku: "Y1", nombre: "Y1", precio: 1 }),
    ).resolves.toMatchObject({ sku: "Y1" });
  });

  it("acepta con remisiones_crear solamente (flujo 'Guardar producto' de RemisionForm)", async () => {
    const user = await createFixtureUser({ username: "soloremisiones", permisos: ["remisiones_crear"] });
    await expect(
      upsertPrecio(user, { sku: "Y2", nombre: "Y2", precio: 1 }),
    ).resolves.toMatchObject({ sku: "Y2" });
  });
});

describe("createRequisicionConFolio — exige Actor con permiso requisiciones; usuario se deriva del actor verificado", () => {
  async function seedProduct(codigo: string): Promise<number> {
    const result = await rawClient().execute({
      sql: "INSERT INTO products (codigo, nombre) VALUES (?1, 'Producto de prueba')",
      args: [codigo],
    });
    return Number(result.lastInsertRowid);
  }

  const baseInput = (productId: number) => ({
    productId,
    productNombre: "Producto de prueba",
    productCodigo: "REQ-1",
    etiqueta: "Etiqueta",
    descripcion: "",
    cantidad: 5,
  });

  it("rechaza a un usuario sin el permiso requisiciones, y no crea ninguna fila", async () => {
    const productId = await seedProduct("REQ-1");
    const user = await createFixtureUser({ username: "sinrequisiciones", permisos: [] });
    await expect(createRequisicionConFolio(user, "REQ-1", baseInput(productId))).rejects.toThrow(
      /no autorizado/i,
    );
    expect(await countRows("requisiciones")).toBe(0);
    expect(await countRows("folios")).toBe(0);
  });

  it("acepta a un usuario con el permiso requisiciones, y usa el username verificado del actor (no un string arbitrario del llamador)", async () => {
    const productId = await seedProduct("REQ-2");
    const user = await createFixtureUser({ username: "conrequisiciones", permisos: ["requisiciones"] });
    const requisicion = await createRequisicionConFolio(user, "REQ-2", baseInput(productId));
    expect(requisicion.usuario).toBe("conrequisiciones");

    const row = await rawClient().execute({
      sql: "SELECT usuario FROM requisiciones WHERE id = ?1",
      args: [requisicion.id],
    });
    expect(row.rows[0].usuario).toBe("conrequisiciones");
  });

  it("un admin pasa sin tener el permiso otorgado explícitamente", async () => {
    const productId = await seedProduct("REQ-3");
    const admin = await createFixtureUser({ username: "admin_requisiciones", rol: "admin", permisos: [] });
    await expect(createRequisicionConFolio(admin, "REQ-3", baseInput(productId))).resolves.toMatchObject({
      usuario: "admin_requisiciones",
    });
  });
});

describe("updatePlasticProductSku — exige sku_master, y solo toca la columna sku", () => {
  async function seedPlasticProduct(): Promise<number> {
    const result = await rawClient().execute(
      `INSERT INTO plastic_products (nombre, sku, color, origen, descripcion, armado, dimension, peso, tipo_empaque, maquila, coste)
       VALUES ('Tapa original', '', 'Rojo', 'Nacional', 'Descripción original', 'Armado A', '10x10', '5g', 'Caja', 'Interna', '1.50')`,
    );
    return Number(result.lastInsertRowid);
  }

  it("rechaza a un usuario sin el permiso sku_master", async () => {
    const id = await seedPlasticProduct();
    const user = await createFixtureUser({ username: "sinskumaster", permisos: ["plasticos"] });
    await expect(updatePlasticProductSku(user, id, "NUEVO-SKU")).rejects.toThrow(/no autorizado/i);
  });

  it("con sku_master, asigna el SKU sin tocar ningún otro campo (a diferencia del update general que sí los sobrescribía con datos potencialmente obsoletos)", async () => {
    const id = await seedPlasticProduct();
    const user = await createFixtureUser({ username: "conskumaster", permisos: ["sku_master"] });

    // Simula el escenario que reportó la auditoría: otro proceso edita la
    // pieza (nombre) DESPUÉS de que SKU Master cargó su lista en memoria.
    await rawClient().execute({
      sql: "UPDATE plastic_products SET nombre = 'Editado por otro proceso' WHERE id = ?1",
      args: [id],
    });

    await updatePlasticProductSku(user, id, "NUEVO-SKU");

    const row = await rawClient().execute({
      sql: "SELECT nombre, sku, color, descripcion FROM plastic_products WHERE id = ?1",
      args: [id],
    });
    expect(row.rows[0]).toMatchObject({
      sku: "NUEVO-SKU",
      nombre: "Editado por otro proceso",
      color: "Rojo",
      descripcion: "Descripción original",
    });
  });
});

describe("clearLogs — exige Actor admin, no expuesta desde LogsPanel", () => {
  it("rechaza a un usuario no-admin aunque tenga sesión vigente", async () => {
    const user = await createFixtureUser({ username: "noadminlogs", permisos: [] });
    await logEvent("INFO", "evento de prueba", "tester");
    await expect(clearLogs(user)).rejects.toThrow(/cuenta administradora/i);
    const logs = await rawClient().execute("SELECT id FROM app_logs");
    expect(logs.rows.length).toBeGreaterThan(0);
  });

  it("acepta a un admin y borra el historial", async () => {
    const admin = await createFixtureUser({ username: "adminlogs", rol: "admin" });
    await logEvent("INFO", "evento de prueba", "tester");
    await clearLogs(admin);
    const logs = await rawClient().execute("SELECT id FROM app_logs");
    expect(logs.rows).toHaveLength(0);
  });
});

describe("lecturas de remisiones — gate de Actor/permiso", () => {
  const baseInput = {
    fecha: "2026-09-04",
    tipo: "interna" as const,
    pedido_bodegas: "JALISCO",
    descuento_pct: 0,
  };
  const renglon = { sku: "R1", producto_nombre: "R1", cantidad: 1, precio_unitario: 100, importe: 100 };

  it("listRemisiones/getRemisionRenglones rechazan sin remisiones_acceso, aceptan con el permiso", async () => {
    const creador = await createFixtureUser({ username: "creador-lect", permisos: ["remisiones_crear"] });
    const created = await createRemisionConFolio(creador, "R1", baseInput, [renglon]);

    const sinAcceso = await createFixtureUser({ username: "sinacceso", permisos: [] });
    await expect(listRemisiones(sinAcceso)).rejects.toThrow(/no autorizado/i);
    await expect(getRemisionRenglones(sinAcceso, created.id)).rejects.toThrow(/no autorizado/i);

    const conAcceso = await createFixtureUser({ username: "conacceso", permisos: ["remisiones_acceso"] });
    await expect(listRemisiones(conAcceso)).resolves.toEqual(expect.any(Array));
    await expect(getRemisionRenglones(conAcceso, created.id)).resolves.toHaveLength(1);
  });

  it("listRemisionRenglonesParaHistorial exige backups_ver", async () => {
    const sinPermiso = await createFixtureUser({ username: "sinbackupsver", permisos: [] });
    await expect(listRemisionRenglonesParaHistorial(sinPermiso)).rejects.toThrow(/no autorizado/i);

    const conPermiso = await createFixtureUser({ username: "conbackupsver", permisos: ["backups_ver"] });
    await expect(listRemisionRenglonesParaHistorial(conPermiso)).resolves.toEqual(expect.any(Array));
  });
});

describe("mutaciones de importación (setPresentacionOriginal/updateProductImage) — exigen Actor admin", () => {
  async function seedProduct(): Promise<number> {
    const creador = await createFixtureUser({ username: `creador-import-${Math.random()}`, permisos: [] });
    return createProduct(creador, emptyProduct, []);
  }

  it("setPresentacionOriginal rechaza a un no-admin y acepta a un admin", async () => {
    const id = await seedProduct();
    const noAdmin = await createFixtureUser({ username: "noadmin-pres", permisos: [] });
    await expect(setPresentacionOriginal(noAdmin, id, "Caja x12")).rejects.toThrow(/cuenta administradora/i);

    const admin = await createFixtureUser({ username: "admin-pres", rol: "admin" });
    await expect(setPresentacionOriginal(admin, id, "Caja x12")).resolves.toBeUndefined();
  });

  it("updateProductImage rechaza a un no-admin y acepta a un admin", async () => {
    const id = await seedProduct();
    const imagen = { data: new Uint8Array([1, 2, 3]), mime: "image/png" };
    const noAdmin = await createFixtureUser({ username: "noadmin-img", permisos: [] });
    await expect(updateProductImage(noAdmin, id, imagen)).rejects.toThrow(/cuenta administradora/i);

    const admin = await createFixtureUser({ username: "admin-img", rol: "admin" });
    await expect(updateProductImage(admin, id, imagen)).resolves.toBeUndefined();
  });
});

describe("lecturas/registros de backups — gate de Actor/permiso", () => {
  it("listBackupHistory/getBackupSettings rechazan sin backups_ver, aceptan con el permiso", async () => {
    await rawClient().execute("INSERT INTO backup_settings (id, automatico_activado) VALUES (1, 0)");

    const sinPermiso = await createFixtureUser({ username: "sinbackupsver2", permisos: [] });
    await expect(listBackupHistory(sinPermiso)).rejects.toThrow(/no autorizado/i);
    await expect(getBackupSettings(sinPermiso)).rejects.toThrow(/no autorizado/i);

    const conPermiso = await createFixtureUser({ username: "conbackupsver2", permisos: ["backups_ver"] });
    await expect(listBackupHistory(conPermiso)).resolves.toEqual(expect.any(Array));
    await expect(getBackupSettings(conPermiso)).resolves.toMatchObject({ automatico_activado: false });
  });

  it("getRecentLogs exige el permiso configuraciones", async () => {
    const sinPermiso = await createFixtureUser({ username: "sinconfig", permisos: [] });
    await expect(getRecentLogs(sinPermiso)).rejects.toThrow(/no autorizado/i);

    const conPermiso = await createFixtureUser({ username: "conconfig", permisos: ["configuraciones"] });
    await expect(getRecentLogs(conPermiso)).resolves.toEqual(expect.any(Array));
  });

  it("recordRestoreResult exige backups_restaurar; no se puede fabricar una fila sin ese permiso", async () => {
    const sinPermiso = await createFixtureUser({ username: "sinrestaurar", permisos: [] });
    await expect(
      recordRestoreResult(sinPermiso, "sinrestaurar", {
        tipo: "RESTAURACION_ARCHIVO_SUBIDO",
        origen: "Archivo subido: falso.sql",
        archivo: "falso.sql",
        estado: "EXITOSO",
      }),
    ).rejects.toThrow(/no autorizado/i);
    expect(await countRows("backup_history")).toBe(0);

    const conPermiso = await createFixtureUser({ username: "conrestaurar", permisos: ["backups_restaurar"] });
    const record = await recordRestoreResult(conPermiso, "conrestaurar", {
      tipo: "RESTAURACION_ARCHIVO_SUBIDO",
      origen: "Archivo subido: real.sql",
      archivo: "real.sql",
      estado: "EXITOSO",
    });
    expect(record.usuario).toBe("conrestaurar");
  });

  it("recordRestoreResult acepta fallbackUsername cuando el token quedó stale por la propia restauración, pero sigue exigiendo el permiso real por id", async () => {
    // Simula lo que reportó la auditoría: restaurar sobrescribe users,
    // incluida la fila del actor que ejecutó la restauración, invalidando el
    // token que confirmRestore() capturó antes de restaurar.
    const conPermiso = await createFixtureUser({ username: "restaurador_stale", permisos: ["backups_restaurar"] });
    await rawClient().execute({
      sql: "UPDATE users SET session_token = 'token-de-otra-sesion' WHERE id = ?1",
      args: [conPermiso.id],
    });

    const record = await recordRestoreResult(conPermiso, "restaurador_stale", {
      tipo: "RESTAURACION_ARCHIVO_SUBIDO",
      origen: "Archivo subido: real.sql",
      archivo: "real.sql",
      estado: "EXITOSO",
    });
    expect(record.usuario).toBe("restaurador_stale");

    // Pero si además de un token stale el usuario tampoco tiene ya el
    // permiso (p. ej. el backup restaurado también le quitó el permiso),
    // sigue rechazado — el fallback nunca debe ser un bypass real.
    const sinPermiso = await createFixtureUser({ username: "sin_permiso_stale", permisos: [] });
    await rawClient().execute({
      sql: "UPDATE users SET session_token = 'token-de-otra-sesion' WHERE id = ?1",
      args: [sinPermiso.id],
    });
    await expect(
      recordRestoreResult(sinPermiso, "sin_permiso_stale", {
        tipo: "RESTAURACION_ARCHIVO_SUBIDO",
        origen: "Archivo subido: falso.sql",
        archivo: "falso.sql",
        estado: "EXITOSO",
      }),
    ).rejects.toThrow(/no autorizado/i);
  });

  it("recordBackupSettingsChange exige backups_configurar; no se puede fabricar una fila sin ese permiso", async () => {
    const sinPermiso = await createFixtureUser({ username: "sinconfigurar", permisos: [] });
    await expect(recordBackupSettingsChange(sinPermiso, "detalle falso")).rejects.toThrow(/no autorizado/i);
    expect(await countRows("backup_history")).toBe(0);

    const conPermiso = await createFixtureUser({ username: "conconfigurar", permisos: ["backups_configurar"] });
    const record = await recordBackupSettingsChange(conPermiso, "detalle real");
    expect(record.usuario).toBe("conconfigurar");
  });
});

describe("logEventAsActor — resuelve el usuario desde la sesión verificada, nunca de un string aparte", () => {
  it("registra el evento con el username del Actor verificado", async () => {
    const user = await createFixtureUser({ username: "logueado", permisos: [] });
    await logEventAsActor(user, "INFO", "evento con actor");

    const logs = await rawClient().execute({
      sql: "SELECT usuario FROM app_logs WHERE mensaje = 'evento con actor'",
      args: [],
    });
    expect(logs.rows[0]?.usuario).toBe("logueado");
  });

  it("es best-effort: un actor inválido no rompe el flujo, solo registra sin usuario", async () => {
    await expect(
      logEventAsActor({ id: 999999, token: "nope" }, "INFO", "evento con actor invalido"),
    ).resolves.toBeUndefined();

    const logs = await rawClient().execute({
      sql: "SELECT usuario FROM app_logs WHERE mensaje = 'evento con actor invalido'",
      args: [],
    });
    expect(logs.rows[0]?.usuario).toBeNull();
  });
});
