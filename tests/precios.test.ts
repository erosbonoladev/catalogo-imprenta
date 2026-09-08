import { beforeEach, describe, expect, it } from "vitest";
import { getPrecio, getPreciosBySkuPrincipal, getPreciosList, searchPrecios, updatePrecio, upsertPrecio } from "../src/db";
import { parseAmount } from "../src/precios";
import { countRows, createFixtureUser, rawClient, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

describe("parseAmount — parser estricto usado por RemisionForm/RemisionDetalleModal/PreciosModal", () => {
  it("acepta enteros y decimales con punto", () => {
    expect(parseAmount("12")).toBe(12);
    expect(parseAmount("12.5")).toBe(12.5);
  });

  it("acepta coma como separador decimal (convención local)", () => {
    expect(parseAmount("12,50")).toBe(12.5);
  });

  it("ignora espacios alrededor", () => {
    expect(parseAmount("  12.5  ")).toBe(12.5);
  });

  it("rechaza un string vacío devolviendo null, no 0 (a diferencia de Number(''))", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("   ")).toBeNull();
  });

  it("rechaza basura con prefijo numérico en vez de aceptar el prefijo como parseFloat", () => {
    expect(parseAmount("12abc")).toBeNull();
    expect(parseAmount("12 pesos")).toBeNull();
  });

  it("rechaza negativos y notación no soportada", () => {
    expect(parseAmount("-5")).toBeNull();
    expect(parseAmount("1e3")).toBeNull();
  });
});

async function actor(permisos: string[] = ["precios_modificar"]) {
  const username = `u-${Math.random().toString(36).slice(2)}`;
  const user = await createFixtureUser({ username, permisos });
  return { ...user, username };
}

describe("upsertPrecio", () => {
  it("crea un precio nuevo y calcula sku_principal quitando letras finales", async () => {
    const a = await actor();
    const precio = await upsertPrecio(a, { sku: "8059C", nombre: "Tapa", precio: 12.5 });
    expect(precio.sku_principal).toBe("8059");

    const stored = await getPrecio(a, "8059C");
    expect(stored).toMatchObject({ sku: "8059C", sku_principal: "8059", precio: 12.5 });
  });

  it("deriva actualizado_por del Actor verificado, no de un string aparte", async () => {
    const a = await actor();
    const precio = await upsertPrecio(a, { sku: "A0", nombre: "Producto A0", precio: 10 });
    expect(precio.actualizado_por).toBe(a.username);

    const historial = await rawClient().execute({
      sql: "SELECT usuario FROM precios_historial WHERE sku = ?1",
      args: ["A0"],
    });
    expect(historial.rows[0].usuario).toBe(a.username);
  });

  it("rechaza un precio negativo o no numérico", async () => {
    const a = await actor();
    await expect(upsertPrecio(a, { sku: "A0N", nombre: "X", precio: -1 })).rejects.toThrow(/precio válido/i);
    await expect(
      upsertPrecio(a, { sku: "A0N", nombre: "X", precio: Number.NaN }),
    ).rejects.toThrow(/precio válido/i);
  });

  it("escribe una fila en precios_historial con precio_anterior null en la primera alta", async () => {
    const a = await actor();
    await upsertPrecio(a, { sku: "A1", nombre: "Producto A", precio: 100 });

    const historial = await rawClient().execute({
      sql: "SELECT precio_anterior, precio_nuevo FROM precios_historial WHERE sku = ?1",
      args: ["A1"],
    });
    expect(historial.rows).toHaveLength(1);
    expect(historial.rows[0]).toMatchObject({ precio_anterior: null, precio_nuevo: 100 });
  });

  it("al actualizar un SKU existente, precio_anterior en el historial es el precio previo", async () => {
    const a = await actor();
    await upsertPrecio(a, { sku: "A2", nombre: "Producto A2", precio: 50 });
    await upsertPrecio(a, { sku: "A2", nombre: "Producto A2", precio: 75 });

    expect(await countRows("precios", "sku = ?1", ["A2"])).toBe(1);
    const historial = await rawClient().execute({
      sql: "SELECT precio_anterior, precio_nuevo FROM precios_historial WHERE sku = ?1 ORDER BY id",
      args: ["A2"],
    });
    expect(historial.rows.map((r) => r.precio_anterior)).toEqual([null, 50]);
    expect(historial.rows.map((r) => r.precio_nuevo)).toEqual([50, 75]);
  });

  it("conserva el tipo existente si no se pasa uno nuevo (no lo borra por una simple edición de precio)", async () => {
    const a = await actor();
    await upsertPrecio(a, { sku: "A3", nombre: "Producto A3", precio: 20, tipo: "interno" });
    const updated = await upsertPrecio(a, { sku: "A3", nombre: "Producto A3", precio: 22 });
    expect(updated.tipo).toBe("interno");
  });

  it("es atómico: si el insert en precios_historial falla, el precio tampoco queda escrito (rollback real, no solo un error reportado)", async () => {
    const a = await actor();
    const raw = rawClient();
    // Fuerza el fallo del segundo statement (INSERT en precios_historial) sin
    // tocar el esquema de producción: renombra la tabla lejos del nombre que
    // upsertPrecio espera, y la restaura siempre en el finally.
    await raw.execute("ALTER TABLE precios_historial RENAME TO precios_historial_tmp");
    try {
      await expect(upsertPrecio(a, { sku: "ROLLBACK1", nombre: "X", precio: 10 })).rejects.toThrow();
    } finally {
      await raw.execute("ALTER TABLE precios_historial_tmp RENAME TO precios_historial");
    }
    expect(await countRows("precios", "sku = ?1", ["ROLLBACK1"])).toBe(0);
  });

  it("es atómico también al actualizar un SKU existente: si falla el historial, el precio previo sigue intacto", async () => {
    const a = await actor();
    await upsertPrecio(a, { sku: "ROLLBACK2", nombre: "X", precio: 10 });

    const raw = rawClient();
    await raw.execute("ALTER TABLE precios_historial RENAME TO precios_historial_tmp");
    try {
      await expect(
        upsertPrecio(a, { sku: "ROLLBACK2", nombre: "X actualizado", precio: 999 }),
      ).rejects.toThrow();
    } finally {
      await raw.execute("ALTER TABLE precios_historial_tmp RENAME TO precios_historial");
    }

    const stored = await getPrecio(a, "ROLLBACK2");
    expect(stored?.precio).toBe(10);
    expect(stored?.nombre).toBe("X");
  });
});

describe("updatePrecio", () => {
  async function seedPrecio(sku: string): Promise<number> {
    const result = await rawClient().execute({
      sql: "INSERT INTO precios (sku, sku_principal, nombre, precio) VALUES (?1, ?1, 'Original', 10)",
      args: [sku],
    });
    return Number(result.lastInsertRowid);
  }

  it("rechaza renombrar a un SKU que ya está en uso por otra fila", async () => {
    await seedPrecio("B1");
    const id2 = await seedPrecio("B2");
    const a = await actor();

    await expect(updatePrecio(a, id2, { sku: "B1", nombre: "Colisión", precio: 1 })).rejects.toThrow(
      /ya está en uso/i,
    );

    // La fila original no debe haber cambiado.
    const stillB2 = await getPrecio(a, "B2");
    expect(stillB2).not.toBeNull();
  });

  it("permite renombrar el SKU cuando no hay colisión", async () => {
    const id = await seedPrecio("C1");
    const a = await actor();
    const updated = await updatePrecio(a, id, { sku: "C1-nuevo", nombre: "Renombrado", precio: 30 });
    expect(updated.sku).toBe("C1-nuevo");
    expect(await getPrecio(a, "C1")).toBeNull();
    expect(await getPrecio(a, "C1-nuevo")).not.toBeNull();
  });

  it("es atómico: si el insert en precios_historial falla, el UPDATE tampoco queda aplicado (rollback real)", async () => {
    const id = await seedPrecio("ROLLBACK3");
    const a = await actor();

    const raw = rawClient();
    await raw.execute("ALTER TABLE precios_historial RENAME TO precios_historial_tmp");
    try {
      await expect(
        updatePrecio(a, id, { sku: "ROLLBACK3-renombrado", nombre: "No debería quedar", precio: 555 }),
      ).rejects.toThrow();
    } finally {
      await raw.execute("ALTER TABLE precios_historial_tmp RENAME TO precios_historial");
    }

    const stored = await getPrecio(a, "ROLLBACK3");
    expect(stored).toMatchObject({ sku: "ROLLBACK3", nombre: "Original", precio: 10 });
    expect(await getPrecio(a, "ROLLBACK3-renombrado")).toBeNull();
  });

  it("rechaza un precio negativo o no numérico", async () => {
    const id = await seedPrecio("D1");
    const a = await actor();
    await expect(updatePrecio(a, id, { sku: "D1", nombre: "X", precio: -5 })).rejects.toThrow(/precio válido/i);
  });
});

describe("lecturas de precios — gate de Actor/permiso", () => {
  async function seedPrecio(sku: string): Promise<void> {
    await rawClient().execute({
      sql: "INSERT INTO precios (sku, sku_principal, nombre, precio) VALUES (?1, ?1, 'Original', 10)",
      args: [sku],
    });
  }

  it("getPrecio/getPreciosBySkuPrincipal/searchPrecios rechazan un actor sin ningún permiso relevante", async () => {
    await seedPrecio("E1");
    const sinPermiso = await actor([]);
    await expect(getPrecio(sinPermiso, "E1")).rejects.toThrow(/no autorizado/i);
    await expect(getPreciosBySkuPrincipal(sinPermiso, "E1")).rejects.toThrow(/no autorizado/i);
    await expect(searchPrecios(sinPermiso, "E1")).rejects.toThrow(/no autorizado/i);
  });

  it("getPrecio acepta remisiones_crear aunque falte precios_ver (no restringe el flujo de Remisiones)", async () => {
    await seedPrecio("E2");
    const soloRemisiones = await actor(["remisiones_crear"]);
    await expect(getPrecio(soloRemisiones, "E2")).resolves.toMatchObject({ sku: "E2" });
  });

  it("getPreciosList rechaza sin precios_ver/precios_modificar/sku_master/backups_ver, acepta con cualquiera", async () => {
    await seedPrecio("E3");
    const sinPermiso = await actor([]);
    await expect(getPreciosList(sinPermiso)).rejects.toThrow(/no autorizado/i);

    const conSkuMaster = await actor(["sku_master"]);
    await expect(getPreciosList(conSkuMaster)).resolves.toEqual(expect.any(Array));
  });

  it("un admin lee sin necesitar ningún permiso otorgado explícitamente", async () => {
    await seedPrecio("E4");
    const admin = await createFixtureUser({ username: "admin-precios", rol: "admin", permisos: [] });
    await expect(getPrecio(admin, "E4")).resolves.toMatchObject({ sku: "E4" });
    await expect(getPreciosList(admin)).resolves.toEqual(expect.any(Array));
  });
});
