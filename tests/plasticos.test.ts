import { beforeEach, describe, expect, it } from "vitest";
import {
  createPlasticProduct,
  deletePlasticItem,
  getConteoPiezasFicha,
  getPlasticItems,
  getPlasticProduct,
  importPiezaRow,
  savePlasticItems,
  updatePlasticProduct,
  updateProductBodega,
} from "../src/db";
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


function insumoItem(nombre: string, cantidad: string, sku = ""): PlasticItem {
  return {
    plastic_product_id: null,
    orden: 1,
    cantidad,
    data: { ...emptyData(), nombre, sku, es_insumo: true },
  };
}

describe("Insumos — SKU INS-NNNN asignado por la app", () => {
  it("el primer insumo recibe INS-0001 y se marca es_insumo", async () => {
    const a = await actor();
    const id = await createPlasticProduct(a, { ...emptyData(), nombre: "Bolsa", es_insumo: true });
    const pieza = await getPlasticProduct(id);
    expect(pieza?.sku).toBe("INS-0001");
    expect(pieza?.es_insumo).toBe(true);
  });

  it("sigue la numeración del máximo ocupado, sin reusar ni rellenar huecos", async () => {
    const a = await actor();
    await createPlasticProduct(a, { ...emptyData(), nombre: "Bolsa 40 x 60", sku: "INS-0024" });
    await createPlasticProduct(a, { ...emptyData(), nombre: "Bolsa 18 x 25", sku: "INS-0048" });
    const id = await createPlasticProduct(a, { ...emptyData(), nombre: "Etiqueta", es_insumo: true });
    expect((await getPlasticProduct(id))?.sku).toBe("INS-0049");
  });

  it("un SKU INS-NNNN que llega de fuera (ej. importación) queda marcado como insumo", async () => {
    const a = await actor();
    const id = await createPlasticProduct(a, { ...emptyData(), nombre: "Bolsa", sku: "INS-0007" });
    const pieza = await getPlasticProduct(id);
    expect(pieza?.sku).toBe("INS-0007");
    expect(pieza?.es_insumo).toBe(true);
  });

  it("dos insumos nuevos en un mismo guardado de ficha reciben números distintos", async () => {
    const productId = await seedProduct("INS-FICHA-1");
    const a = await actor();
    await savePlasticItems(a, productId, [
      newItem("Caballo", "C-1", "2"),
      insumoItem("Bolsa A", "1"),
      insumoItem("Bolsa B", "1"),
    ]);
    const items = await getPlasticItems(productId);
    const skus = items.map((i) => i.data.sku).sort();
    expect(skus).toEqual(["C-1", "INS-0001", "INS-0002"]);
    expect(items.filter((i) => i.data.es_insumo)).toHaveLength(2);
  });

  it("una pieza normal marcada como insumo pasa a INS-NNNN; la pieza ya guardada no cambia de SKU al reeditarse", async () => {
    const a = await actor();
    const id = await createPlasticProduct(a, { ...emptyData(), nombre: "Bolsa", sku: "B-1" });
    await updatePlasticProduct(a, id, { ...emptyData(), nombre: "Bolsa", sku: "B-1", es_insumo: true });
    const convertida = await getPlasticProduct(id);
    expect(convertida?.sku).toBe("INS-0001");
    expect(convertida?.es_insumo).toBe(true);

    await updatePlasticProduct(a, id, { ...emptyData(), nombre: "Bolsa grande", sku: "OTRO", es_insumo: false });
    const reeditada = await getPlasticProduct(id);
    expect(reeditada?.sku).toBe("INS-0001");
    expect(reeditada?.es_insumo).toBe(true);
    expect(reeditada?.nombre).toBe("Bolsa grande");
  });

  it("el índice único impide dos insumos con el mismo SKU", async () => {
    const a = await actor();
    await createPlasticProduct(a, { ...emptyData(), nombre: "Bolsa", sku: "INS-0024" });
    await expect(
      createPlasticProduct(a, { ...emptyData(), nombre: "Bolsa otra vez", sku: "INS-0024" }),
    ).rejects.toThrow();
  });

  it("exige el permiso plasticos", async () => {
    const sinPermiso = await actor([]);
    await expect(
      createPlasticProduct(sinPermiso, { ...emptyData(), nombre: "Bolsa", es_insumo: true }),
    ).rejects.toThrow(/No autorizado/);
  });
});

describe("getConteoPiezasFicha", () => {
  it("separa la cantidad de piezas de la de insumos y reporta los vínculos sin cantidad", async () => {
    const productId = await seedProduct("CONTEO-1");
    const a = await actor();
    await savePlasticItems(a, productId, [
      newItem("Caballo", "C-1", "4"),
      newItem("Jinete", "C-2", "6"),
      newItem("Corral", "C-3", ""),
      insumoItem("Bolsa", "2"),
      insumoItem("Instructivo", "1"),
    ]);
    expect(await getConteoPiezasFicha(productId)).toEqual({ piezas: 10, insumos: 3, sinCantidad: 1 });
  });

  it("una ficha sin piezas cuenta cero", async () => {
    const productId = await seedProduct("CONTEO-2");
    expect(await getConteoPiezasFicha(productId)).toEqual({ piezas: 0, insumos: 0, sinCantidad: 0 });
  });
});

describe("updateProductBodega", () => {
  it("guarda tipo y datos de empaque sin tocar el resto de la ficha", async () => {
    const productId = await seedProduct("BODEGA-1");
    const a = await actor([]);
    await updateProductBodega(a, productId, {
      tipo_producto: "",
      dimensiones_empaque: " 28 x 28 cm ",
      juegos_por_empaque: "12",
      peso_empaque: "3.5",
      volumen_empaque: "",
    });
    const row = (
      await rawClient().execute({ sql: "SELECT * FROM products WHERE id = ?1", args: [productId] })
    ).rows[0] as unknown as Record<string, unknown>;
    expect(row.dimensiones_empaque).toBe("28 x 28 cm");
    expect(row.juegos_por_empaque).toBe("12");
    expect(row.peso_empaque).toBe("3.5");
    expect(row.volumen_empaque).toBeNull();
    expect(row.nombre).toBe("Producto de prueba");
  });

  it("rechaza un tipo de producto fuera de la lista", async () => {
    const productId = await seedProduct("BODEGA-2");
    const a = await actor([]);
    await expect(
      updateProductBodega(a, productId, {
        tipo_producto: "Inventado",
        dimensiones_empaque: "",
        juegos_por_empaque: "",
        peso_empaque: "",
        volumen_empaque: "",
      }),
    ).rejects.toThrow(/Tipo de producto inválido/);
  });

  it("rechaza una sesión inválida", async () => {
    const productId = await seedProduct("BODEGA-3");
    await expect(
      updateProductBodega({ id: 999999, token: "nope" }, productId, {
        tipo_producto: "",
        dimensiones_empaque: "",
        juegos_por_empaque: "",
        peso_empaque: "",
        volumen_empaque: "",
      }),
    ).rejects.toThrow();
  });
});

describe("importPiezaRow — Cantidad del vínculo nuevo", () => {
  it("toma Componentes de fabricación como Cantidad al crear el vínculo, sin pisar una Cantidad ya capturada", async () => {
    const productId = await seedProduct("IMPORT-CANT-1");
    const a = await actor();
    const conComponentes = { ...emptyData(), nombre: "Rueda", sku: "R-1", componentes_fabricacion: " 4 " };

    const id = await importPiezaRow(a, productId, null, conComponentes, 1);
    expect((await getPlasticItems(productId))[0].cantidad).toBe("4");

    await rawClient().execute({
      sql: "UPDATE product_plastic_items SET cantidad = '9' WHERE product_id = ?1",
      args: [productId],
    });
    await importPiezaRow(a, productId, id, { ...conComponentes, componentes_fabricacion: "2" }, 1);
    expect((await getPlasticItems(productId))[0].cantidad).toBe("9");
  });
});
