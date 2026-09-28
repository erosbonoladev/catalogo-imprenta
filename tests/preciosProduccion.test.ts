import { beforeEach, describe, expect, it } from "vitest";
import { createProduct, getPrecioProduccion, savePrecioProduccion } from "../src/db";
import { createFixtureUser, rawClient, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

async function actor(permisos: string[] = ["precios_produccion_modificar"]) {
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
      dimensiones_empaque: "",
      juegos_por_empaque: "",
      peso_empaque: "",
      volumen_empaque: "",
    },
    [],
  );
}

describe("getPrecioProduccion", () => {
  it("devuelve precio null si el producto no tiene ninguna fila todavía", async () => {
    const a = await actor(["precios_produccion_ver"]);
    const productId = await seedProduct(a, "PP1");

    const precio = await getPrecioProduccion(a, productId);
    expect(precio.product_id).toBe(productId);
    expect(precio.precio).toBeNull();
    expect(precio.actualizado_en).toBeNull();
  });

  it("rechaza a un actor sin precios_produccion_ver/precios_produccion_modificar", async () => {
    const a = await actor(["precios_produccion_modificar"]);
    const productId = await seedProduct(a, "PP2");
    const sinPermiso = await actor([]);
    await expect(getPrecioProduccion(sinPermiso, productId)).rejects.toThrow(/no autorizado/i);
  });
});

describe("savePrecioProduccion", () => {
  it("guarda el precio y lo persiste asociado al producto correcto", async () => {
    const a = await actor();
    const productId = await seedProduct(a, "PP3");

    const updated = await savePrecioProduccion(a, productId, 42.5);
    expect(updated.precio).toBe(42.5);

    const rows = await rawClient().execute({
      sql: "SELECT precio, product_id FROM precios_produccion WHERE product_id = ?1",
      args: [productId],
    });
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].product_id).toBe(productId);
  });

  it("no duplica filas al guardar dos veces (upsert por product_id)", async () => {
    const a = await actor();
    const productId = await seedProduct(a, "PP4");
    await savePrecioProduccion(a, productId, 10);
    await savePrecioProduccion(a, productId, 15);

    const rows = await rawClient().execute({
      sql: "SELECT precio FROM precios_produccion WHERE product_id = ?1",
      args: [productId],
    });
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].precio).toBe(15);
  });

  it("permite dejar el precio en blanco (null), no lo fuerza a 0", async () => {
    const a = await actor();
    const productId = await seedProduct(a, "PP5");
    await savePrecioProduccion(a, productId, 10);
    const updated = await savePrecioProduccion(a, productId, null);
    expect(updated.precio).toBeNull();
  });

  it("rechaza un precio negativo o no numérico", async () => {
    const a = await actor();
    const productId = await seedProduct(a, "PP6");
    await expect(savePrecioProduccion(a, productId, -1)).rejects.toThrow(/precio válido/i);
    await expect(savePrecioProduccion(a, productId, Number.NaN)).rejects.toThrow(/precio válido/i);
  });

  it("rechaza un actor sin precios_produccion_modificar (precios_produccion_ver no alcanza para escribir)", async () => {
    const a = await actor(["precios_produccion_modificar"]);
    const productId = await seedProduct(a, "PP7");
    const soloVer = await actor(["precios_produccion_ver"]);
    await expect(savePrecioProduccion(soloVer, productId, 1)).rejects.toThrow(/no autorizado/i);
  });

  it("deriva actualizado_por del Actor verificado", async () => {
    const a = await actor();
    const productId = await seedProduct(a, "PP8");
    const updated = await savePrecioProduccion(a, productId, 1);
    expect(updated.actualizado_por).toBe(a.username);
  });

  it("un admin puede escribir sin necesitar el permiso otorgado explícitamente", async () => {
    const creador = await actor();
    const productId = await seedProduct(creador, "PP9");
    const admin = await createFixtureUser({ username: "admin-precios-produccion", rol: "admin", permisos: [] });
    await expect(savePrecioProduccion(admin, productId, 1)).resolves.toMatchObject({ precio: 1 });
  });

  it("es independiente de precios_venta y precios (Precios Imprenta) — no comparte tabla ni se ve afectado por ellas", async () => {
    const a = await actor();
    const productId = await seedProduct(a, "PP10");
    await savePrecioProduccion(a, productId, 99);
    const rows = await rawClient().execute({
      sql: "SELECT COUNT(*) as n FROM precios_venta WHERE product_id = ?1",
      args: [productId],
    });
    expect(rows.rows[0].n).toBe(0);
  });
});
