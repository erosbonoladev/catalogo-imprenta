import { beforeEach, describe, expect, it } from "vitest";
import { createProduct, getPreciosVenta, savePreciosVenta } from "../src/db";
import { PRECIOS_VENTA_CATEGORIAS } from "../src/types";
import { createFixtureUser, rawClient, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

async function actor(permisos: string[] = ["precios_venta_modificar"]) {
  const username = `u-${Math.random().toString(36).slice(2)}`;
  const user = await createFixtureUser({ username, permisos });
  return { ...user, username };
}

async function seedProduct(actorRef: { id: number; token: string }, codigo: string): Promise<number> {
  return createProduct(
    actorRef,
    {
      codigo,
      nombre: `Producto ${codigo}`,
      categoria: "",
      material: "",
      descripcion: "",
      imagen: null,
      imagen_codigo_barras: null,
      tipo_producto: "",
      codigo_barras_texto: "",
    },
    [],
  );
}

describe("getPreciosVenta — normaliza siempre a las 5 categorías fijas", () => {
  it("devuelve las 5 categorías en orden con precio null si el producto no tiene ninguna fila todavía", async () => {
    const a = await actor(["precios_venta_ver"]);
    const productId = await seedProduct(a, "PV1");

    const precios = await getPreciosVenta(a, productId);
    expect(precios.map((p) => p.categoria)).toEqual([...PRECIOS_VENTA_CATEGORIAS]);
    expect(precios.every((p) => p.precio === null)).toBe(true);
  });

  it("rechaza a un actor sin precios_venta_ver/precios_venta_modificar", async () => {
    const a = await actor(["precios_venta_modificar"]);
    const productId = await seedProduct(a, "PV2");
    const sinPermiso = await actor([]);
    await expect(getPreciosVenta(sinPermiso, productId)).rejects.toThrow(/no autorizado/i);
  });
});

describe("savePreciosVenta", () => {
  it("guarda las 5 categorías y las persiste asociadas al producto correcto", async () => {
    const a = await actor();
    const productId = await seedProduct(a, "PV3");

    const entradas = PRECIOS_VENTA_CATEGORIAS.map((categoria, i) => ({
      categoria,
      precio: (i + 1) * 10,
    }));
    const updated = await savePreciosVenta(a, productId, entradas);
    expect(updated.map((p) => p.precio)).toEqual([10, 20, 30, 40, 50]);

    const rows = await rawClient().execute({
      sql: "SELECT categoria, precio, product_id FROM precios_venta WHERE product_id = ?1",
      args: [productId],
    });
    expect(rows.rows).toHaveLength(5);
    expect(rows.rows.every((r) => r.product_id === productId)).toBe(true);
  });

  it("no duplica filas al guardar dos veces (upsert por product_id+categoria)", async () => {
    const a = await actor();
    const productId = await seedProduct(a, "PV4");
    const entrada = [{ categoria: "Gobierno" as const, precio: 5 }];
    await savePreciosVenta(a, productId, entrada);
    await savePreciosVenta(a, productId, [{ categoria: "Gobierno" as const, precio: 8 }]);

    const rows = await rawClient().execute({
      sql: "SELECT precio FROM precios_venta WHERE product_id = ?1 AND categoria = 'Gobierno'",
      args: [productId],
    });
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].precio).toBe(8);
  });

  it("permite dejar una categoría sin precio (null), no la fuerza a 0", async () => {
    const a = await actor();
    const productId = await seedProduct(a, "PV5");
    await savePreciosVenta(a, productId, [{ categoria: "Mayoreo", precio: null }]);
    const [mayoreo] = (await getPreciosVenta(a, productId)).filter((p) => p.categoria === "Mayoreo");
    expect(mayoreo.precio).toBeNull();
  });

  it("rechaza una categoría fuera de la lista controlada, sin escribir nada", async () => {
    const a = await actor();
    const productId = await seedProduct(a, "PV6");
    await expect(
      savePreciosVenta(a, productId, [{ categoria: "Inventada" as never, precio: 10 }]),
    ).rejects.toThrow(/categoría/i);

    const rows = await rawClient().execute({
      sql: "SELECT COUNT(*) as n FROM precios_venta WHERE product_id = ?1",
      args: [productId],
    });
    expect(rows.rows[0].n).toBe(0);
  });

  it("rechaza un precio negativo o no numérico", async () => {
    const a = await actor();
    const productId = await seedProduct(a, "PV7");
    await expect(
      savePreciosVenta(a, productId, [{ categoria: "Gobierno", precio: -1 }]),
    ).rejects.toThrow(/precio válido/i);
    await expect(
      savePreciosVenta(a, productId, [{ categoria: "Gobierno", precio: Number.NaN }]),
    ).rejects.toThrow(/precio válido/i);
  });

  it("valida todo antes de escribir: si una entrada es inválida, ninguna de las otras queda guardada", async () => {
    const a = await actor();
    const productId = await seedProduct(a, "PV8");
    await expect(
      savePreciosVenta(a, productId, [
        { categoria: "Gobierno", precio: 10 },
        { categoria: "Representante", precio: -5 },
      ]),
    ).rejects.toThrow();

    const rows = await rawClient().execute({
      sql: "SELECT COUNT(*) as n FROM precios_venta WHERE product_id = ?1",
      args: [productId],
    });
    expect(rows.rows[0].n).toBe(0);
  });

  it("rechaza un actor sin precios_venta_modificar (precios_venta_ver no alcanza para escribir)", async () => {
    const a = await actor(["precios_venta_modificar"]);
    const productId = await seedProduct(a, "PV9");
    const soloVer = await actor(["precios_venta_ver"]);
    await expect(
      savePreciosVenta(soloVer, productId, [{ categoria: "Gobierno", precio: 1 }]),
    ).rejects.toThrow(/no autorizado/i);
  });

  it("deriva actualizado_por del Actor verificado", async () => {
    const a = await actor();
    const productId = await seedProduct(a, "PV10");
    const updated = await savePreciosVenta(a, productId, [{ categoria: "Gobierno", precio: 1 }]);
    const gobierno = updated.find((p) => p.categoria === "Gobierno");
    expect(gobierno?.actualizado_por).toBe(a.username);
  });

  it("un admin puede escribir sin necesitar el permiso otorgado explícitamente", async () => {
    const creador = await actor();
    const productId = await seedProduct(creador, "PV11");
    const admin = await createFixtureUser({ username: "admin-precios-venta", rol: "admin", permisos: [] });
    await expect(
      savePreciosVenta(admin, productId, [{ categoria: "Gobierno", precio: 1 }]),
    ).resolves.toEqual(expect.any(Array));
  });
});
