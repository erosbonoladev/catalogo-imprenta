import { beforeEach, describe, expect, it } from "vitest";
import { getPrecio, updatePrecio, upsertPrecio } from "../src/db";
import { countRows, createFixtureUser, rawClient, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

async function actor(permisos: string[] = ["precios_modificar"]) {
  return createFixtureUser({ username: `u-${Math.random().toString(36).slice(2)}`, permisos });
}

describe("upsertPrecio", () => {
  it("crea un precio nuevo y calcula sku_principal quitando letras finales", async () => {
    const a = await actor();
    const precio = await upsertPrecio(a, { sku: "8059C", nombre: "Tapa", precio: 12.5, usuario: "tester" });
    expect(precio.sku_principal).toBe("8059");

    const stored = await getPrecio("8059C");
    expect(stored).toMatchObject({ sku: "8059C", sku_principal: "8059", precio: 12.5 });
  });

  it("escribe una fila en precios_historial con precio_anterior null en la primera alta", async () => {
    const a = await actor();
    await upsertPrecio(a, { sku: "A1", nombre: "Producto A", precio: 100, usuario: "tester" });

    const historial = await rawClient().execute({
      sql: "SELECT precio_anterior, precio_nuevo FROM precios_historial WHERE sku = ?1",
      args: ["A1"],
    });
    expect(historial.rows).toHaveLength(1);
    expect(historial.rows[0]).toMatchObject({ precio_anterior: null, precio_nuevo: 100 });
  });

  it("al actualizar un SKU existente, precio_anterior en el historial es el precio previo", async () => {
    const a = await actor();
    await upsertPrecio(a, { sku: "A2", nombre: "Producto A2", precio: 50, usuario: "tester" });
    await upsertPrecio(a, { sku: "A2", nombre: "Producto A2", precio: 75, usuario: "tester" });

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
    await upsertPrecio(a, { sku: "A3", nombre: "Producto A3", precio: 20, usuario: "tester", tipo: "interno" });
    const updated = await upsertPrecio(a, { sku: "A3", nombre: "Producto A3", precio: 22, usuario: "tester" });
    expect(updated.tipo).toBe("interno");
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

    await expect(
      updatePrecio(a, id2, { sku: "B1", nombre: "Colisión", precio: 1, usuario: null }),
    ).rejects.toThrow(/ya está en uso/i);

    // La fila original no debe haber cambiado.
    const stillB2 = await getPrecio("B2");
    expect(stillB2).not.toBeNull();
  });

  it("permite renombrar el SKU cuando no hay colisión", async () => {
    const id = await seedPrecio("C1");
    const a = await actor();
    const updated = await updatePrecio(a, id, { sku: "C1-nuevo", nombre: "Renombrado", precio: 30, usuario: null });
    expect(updated.sku).toBe("C1-nuevo");
    expect(await getPrecio("C1")).toBeNull();
    expect(await getPrecio("C1-nuevo")).not.toBeNull();
  });
});
