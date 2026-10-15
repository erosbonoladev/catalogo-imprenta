import { beforeEach, describe, expect, it } from "vitest";
import { deletePlasticItem, getPlasticItems, getPlasticProduct, savePlasticItems } from "../src/db";
import type { PlasticItem, PlasticProductInput } from "../src/types";
import { countRows, createFixtureUser, rawClient, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

async function actor(permisos: string[] = ["plasticos"]) {
  return createFixtureUser({ username: `u-${Math.random().toString(36).slice(2)}`, permisos });
}

async function seedProduct(codigo: string): Promise<number> {
  const result = await rawClient().execute({
    sql: "INSERT INTO products (codigo, nombre) VALUES (?1, 'Producto de prueba')",
    args: [codigo],
  });
  return Number(result.lastInsertRowid);
}

function emptyData(): PlasticProductInput {
  return {
    nombre: "",
    sku: "",
    color: "",
    origen: "",
    descripcion: "",
    material: "",
    dimension: "",
    peso: "",
    maquila: "",
    coste: "",
    componentes_fabricacion: "",
    precio_por_pieza: "",
    precio_por_juego: "",
    imagen: null,
  };
}

function newItem(nombre: string, sku: string, cantidad: string): PlasticItem {
  return {
    plastic_product_id: null,
    orden: 1,
    cantidad,
    data: { ...emptyData(), nombre, sku },
  };
}

describe("savePlasticItems/getPlasticItems — cantidad por vínculo ficha↔pieza", () => {
  it("guarda y recupera la cantidad de una pieza nueva ligada al juego", async () => {
    const productId = await seedProduct("PIEZAS-CANTIDAD-1");
    const a = await actor();

    await savePlasticItems(a, productId, [newItem("Rueda", "R-1", "4")]);

    const items = await getPlasticItems(productId);
    expect(items).toHaveLength(1);
    expect(items[0].cantidad).toBe("4");
  });

  it("una pieza sin cantidad capturada guarda/recupera '' en vez de inventar un valor", async () => {
    const productId = await seedProduct("PIEZAS-CANTIDAD-2");
    const a = await actor();

    await savePlasticItems(a, productId, [newItem("Eje", "E-1", "")]);

    const items = await getPlasticItems(productId);
    expect(items[0].cantidad).toBe("");
  });

  it("actualizar la cantidad de una pieza ya ligada la persiste (replace-and-reinsert del vínculo)", async () => {
    const productId = await seedProduct("PIEZAS-CANTIDAD-3");
    const a = await actor();

    await savePlasticItems(a, productId, [newItem("Tornillo", "T-1", "2")]);
    const [saved] = await getPlasticItems(productId);

    await savePlasticItems(a, productId, [{ ...saved, cantidad: "10" }]);
    const [updated] = await getPlasticItems(productId);

    expect(updated.cantidad).toBe("10");
    expect(updated.plastic_product_id).toBe(saved.plastic_product_id);
  });
});

describe("savePlasticItems — guardado atómico en un solo batch", () => {
  it("mezcla de piezas existentes y nuevas: cada vínculo apunta a SU pieza y conserva el orden del arreglo", async () => {
    const productId = await seedProduct("PIEZAS-BATCH-1");
    const a = await actor();
    await savePlasticItems(a, productId, [newItem("Vieja", "V-1", "1")]);
    const [vieja] = await getPlasticItems(productId);

    await savePlasticItems(a, productId, [
      newItem("Nueva A", "N-A", "2"),
      { ...vieja, data: { ...vieja.data, color: "Rojo" } },
      newItem("", "", "9"),
      newItem("Nueva B", "N-B", "3"),
    ]);

    const items = await getPlasticItems(productId);
    expect(items.map((i) => [i.data.nombre, i.orden, i.cantidad])).toEqual([
      ["Nueva A", 1, "2"],
      ["Vieja", 2, "1"],
      ["Nueva B", 3, "3"],
    ]);
    expect(items[1].plastic_product_id).toBe(vieja.plastic_product_id);
    expect(items[1].data.color).toBe("Rojo");
    expect(new Set(items.map((i) => i.plastic_product_id)).size).toBe(3);
    expect(await countRows("plastic_products")).toBe(3);
  });

  it("si una pieza falla, no queda nada a medias (ni piezas nuevas ni el vínculo viejo borrado)", async () => {
    const productId = await seedProduct("PIEZAS-BATCH-2");
    const a = await actor();
    await savePlasticItems(a, productId, [newItem("Original", "O-1", "1")]);

    // El esquema de pruebas no tiene FKs: un trigger fuerza el fallo en el
    // INSERT del segundo vínculo, con la pieza nueva ya insertada antes.
    await rawClient().execute(
      "CREATE TRIGGER fail_link BEFORE INSERT ON product_plastic_items WHEN NEW.cantidad = 'BOOM' BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    try {
      await expect(
        savePlasticItems(a, productId, [newItem("No debe quedar", "X-1", "1"), newItem("Falla", "X-2", "BOOM")]),
      ).rejects.toThrow(/boom/);
    } finally {
      await rawClient().execute("DROP TRIGGER fail_link");
    }

    const items = await getPlasticItems(productId);
    expect(items.map((i) => i.data.nombre)).toEqual(["Original"]);
    expect(await countRows("plastic_products")).toBe(1);
  });

  it("rechaza a un actor sin `plasticos` y no escribe nada", async () => {
    const productId = await seedProduct("PIEZAS-BATCH-3");
    const sin = await actor([]);
    await expect(savePlasticItems(sin, productId, [newItem("X", "X-1", "1")])).rejects.toThrow(/no autorizado/i);
    expect(await countRows("plastic_products")).toBe(0);
  });

  it("guarda una ficha grande (60 piezas) completa y en orden", async () => {
    const productId = await seedProduct("PIEZAS-BATCH-4");
    const a = await actor();
    const items = Array.from({ length: 60 }, (_, i) => newItem(`Pieza ${i + 1}`, `P-${i + 1}`, String(i + 1)));
    await savePlasticItems(a, productId, items);

    const saved = await getPlasticItems(productId);
    expect(saved).toHaveLength(60);
    expect(saved.map((i) => i.data.nombre)).toEqual(items.map((i) => i.data.nombre));
  });
});

describe("deletePlasticItem — quita una pieza de una ficha sin borrarla del catálogo", () => {
  it("quita solo el vínculo pedido, deja la pieza maestra y el resto de vínculos de la ficha intactos", async () => {
    const productId = await seedProduct("IMPRENTA-QUITAR-1");
    const a = await actor();
    await savePlasticItems(a, productId, [
      newItem("Instructivo", "I-1", "1"),
      newItem("Caja", "C-1", "2"),
    ]);
    const [instructivo, caja] = await getPlasticItems(productId);

    await deletePlasticItem(a, instructivo.id!);

    const restantes = await getPlasticItems(productId);
    expect(restantes.map((i) => i.data.nombre)).toEqual(["Caja"]);
    expect(restantes[0].id).toBe(caja.id);

    // La pieza maestra sigue en plastic_products — deletePlasticItem no es
    // deletePlasticProduct, no borra el catálogo.
    const pieza = await getPlasticProduct(instructivo.plastic_product_id!);
    expect(pieza?.nombre).toBe("Instructivo");
  });

  it("no toca los vínculos de la misma pieza en otra ficha", async () => {
    const productId1 = await seedProduct("IMPRENTA-QUITAR-2A");
    const productId2 = await seedProduct("IMPRENTA-QUITAR-2B");
    const a = await actor();
    await savePlasticItems(a, productId1, [newItem("Instructivo compartido", "IC-1", "1")]);
    const [enFicha1] = await getPlasticItems(productId1);
    await rawClient().execute({
      sql: "INSERT INTO product_plastic_items (product_id, plastic_product_id, orden) VALUES (?1, ?2, 1)",
      args: [productId2, enFicha1.plastic_product_id],
    });

    await deletePlasticItem(a, enFicha1.id!);

    expect(await getPlasticItems(productId1)).toHaveLength(0);
    expect(await getPlasticItems(productId2)).toHaveLength(1);
  });

  it("rechaza a un actor sin `plasticos`", async () => {
    const productId = await seedProduct("IMPRENTA-QUITAR-3");
    const a = await actor();
    await savePlasticItems(a, productId, [newItem("Instructivo", "I-1", "1")]);
    const [linked] = await getPlasticItems(productId);

    const sinPermiso = await actor(["imprenta"]);
    await expect(deletePlasticItem(sinPermiso, linked.id!)).rejects.toThrow(/no autorizado/i);
    expect(await countRows("product_plastic_items", "id = ?1", [linked.id])).toBe(1);
  });
});
