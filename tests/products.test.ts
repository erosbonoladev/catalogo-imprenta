import { beforeEach, describe, expect, it } from "vitest";
import {
  createProduct,
  findProductsByBarcode,
  getProduct,
  searchProducts,
  updateProduct,
  updateProductBarcodeImage,
} from "../src/db";
import { TIPOS_PRODUCTO } from "../src/types";
import { createFixtureUser, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

async function actor() {
  return createFixtureUser({ username: `u-${Math.random().toString(36).slice(2)}`, permisos: [] });
}

async function actorAdmin() {
  return createFixtureUser({ username: `admin-${Math.random().toString(36).slice(2)}`, rol: "admin" });
}

const base = {
  categoria: "",
  material: "",
  descripcion: "",
  imagen: null,
  imagen_codigo_barras: null,
};

describe("tipo_producto — valor controlado", () => {
  it("acepta cualquier valor de la lista fija", async () => {
    const a = await actor();
    const id = await createProduct(a, { ...base, codigo: "TP1", nombre: "X", tipo_producto: "Dominós", codigo_barras_texto: "" }, []);
    const stored = await getProduct(id);
    expect(stored?.tipo_producto).toBe("Dominós");
  });

  it("acepta vacío (sin asignar)", async () => {
    const a = await actor();
    const id = await createProduct(a, { ...base, codigo: "TP2", nombre: "X", tipo_producto: "", codigo_barras_texto: "" }, []);
    const stored = await getProduct(id);
    expect(stored?.tipo_producto).toBe("");
  });

  it("rechaza un valor fuera de la lista, tanto al crear como al actualizar", async () => {
    const a = await actor();
    await expect(
      createProduct(a, { ...base, codigo: "TP3", nombre: "X", tipo_producto: "Inventado", codigo_barras_texto: "" }, []),
    ).rejects.toThrow(/tipo de producto inválido/i);

    const id = await createProduct(a, { ...base, codigo: "TP4", nombre: "X", tipo_producto: "", codigo_barras_texto: "" }, []);
    await expect(
      updateProduct(a, id, { ...base, codigo: "TP4", nombre: "X", tipo_producto: "Otro inventado", codigo_barras_texto: "" }, []),
    ).rejects.toThrow(/tipo de producto inválido/i);
  });

  it("cubre los 49 valores documentados sin que ninguno sea rechazado", async () => {
    const a = await actor();
    for (const [i, tipo] of TIPOS_PRODUCTO.entries()) {
      await createProduct(a, { ...base, codigo: `TP-ALL-${i}`, nombre: tipo, tipo_producto: tipo, codigo_barras_texto: "" }, []);
    }
  });
});

describe("codigo_barras_texto — se guarda como texto, no como número", () => {
  it("preserva ceros iniciales al crear y al leer", async () => {
    const a = await actor();
    const id = await createProduct(
      a,
      { ...base, codigo: "CB1", nombre: "X", tipo_producto: "", codigo_barras_texto: "00123045" },
      [],
    );
    const stored = await getProduct(id);
    expect(stored?.codigo_barras_texto).toBe("00123045");
  });

  it("preserva ceros iniciales al actualizar", async () => {
    const a = await actor();
    const id = await createProduct(a, { ...base, codigo: "CB2", nombre: "X", tipo_producto: "", codigo_barras_texto: "" }, []);
    await updateProduct(a, id, { ...base, codigo: "CB2", nombre: "X", tipo_producto: "", codigo_barras_texto: "007" }, []);
    const stored = await getProduct(id);
    expect(stored?.codigo_barras_texto).toBe("007");
  });

  it("una ficha existente sin código de barras se muestra vacía, no rompe la lectura", async () => {
    const a = await actor();
    const id = await createProduct(a, { ...base, codigo: "CB3", nombre: "X", tipo_producto: "", codigo_barras_texto: "" }, []);
    const stored = await getProduct(id);
    expect(stored?.codigo_barras_texto).toBe("");
  });
});

describe("findProductsByBarcode — usado por la captura masiva de código de barras", () => {
  it("encuentra la ficha por código de barras exacto, sin traer el BLOB de imagen", async () => {
    const a = await actor();
    await createProduct(
      a,
      { ...base, codigo: "CB10", nombre: "Tangram", tipo_producto: "", codigo_barras_texto: "7501234567890" },
      [],
    );
    const matches = await findProductsByBarcode("7501234567890");
    expect(matches).toEqual([
      { id: expect.any(Number), codigo: "CB10", nombre: "Tangram", tieneImagenBarras: false },
    ]);
  });

  it("tieneImagenBarras refleja si ya tiene una imagen de código de barras asignada", async () => {
    const a = await actor();
    const admin = await actorAdmin();
    const id = await createProduct(
      a,
      { ...base, codigo: "CB11", nombre: "X", tipo_producto: "", codigo_barras_texto: "1112223334445" },
      [],
    );
    await updateProductBarcodeImage(admin, id, { data: new Uint8Array([1, 2, 3]), mime: "image/png" });
    const matches = await findProductsByBarcode("1112223334445");
    expect(matches[0].tieneImagenBarras).toBe(true);
  });

  it("no encuentra nada si ninguna ficha tiene ese código de barras", async () => {
    const matches = await findProductsByBarcode("0000000000000");
    expect(matches).toEqual([]);
  });

  it("devuelve varias fichas si comparten el mismo código de barras (dato repetido)", async () => {
    const a = await actor();
    await createProduct(a, { ...base, codigo: "CB12", nombre: "A", tipo_producto: "", codigo_barras_texto: "9998887776665" }, []);
    await createProduct(a, { ...base, codigo: "CB13", nombre: "B", tipo_producto: "", codigo_barras_texto: "9998887776665" }, []);
    const matches = await findProductsByBarcode("9998887776665");
    expect(matches.map((m) => m.codigo).sort()).toEqual(["CB12", "CB13"]);
  });
});

describe("updateProductBarcodeImage — solo toca imagen_codigo_barras, no el resto de la ficha", () => {
  it("guarda la imagen y su mime sin modificar otros campos", async () => {
    const a = await actor();
    const admin = await actorAdmin();
    const id = await createProduct(
      a,
      { ...base, codigo: "CB14", nombre: "Original", tipo_producto: "", codigo_barras_texto: "1231231231234" },
      [],
    );
    await updateProductBarcodeImage(admin, id, { data: new Uint8Array([9, 9]), mime: "image/svg+xml" });
    const stored = await getProduct(id);
    expect(stored?.imagen_codigo_barras?.mime).toBe("image/svg+xml");
    expect(stored?.nombre).toBe("Original");
  });
});

describe("searchProducts — 'todo' también encuentra por código de barras", () => {
  it("un término que coincide con codigo_barras_texto devuelve la ficha", async () => {
    const a = await actor();
    await createProduct(
      a,
      { ...base, codigo: "CB15", nombre: "Rompecabezas", tipo_producto: "", codigo_barras_texto: "7501234567890" },
      [],
    );
    const results = await searchProducts("7501234567890", "todo");
    expect(results.map((p) => p.codigo)).toContain("CB15");
  });

  it("un término que no coincide con nada no devuelve la ficha", async () => {
    const a = await actor();
    await createProduct(
      a,
      { ...base, codigo: "CB16", nombre: "Otro", tipo_producto: "", codigo_barras_texto: "7501234567890" },
      [],
    );
    const results = await searchProducts("0000000000000", "todo");
    expect(results.map((p) => p.codigo)).not.toContain("CB16");
  });
});

describe("searchProducts — filtro dedicado 'codigo_barras'", () => {
  it("encuentra la ficha por código de barras exacto", async () => {
    const a = await actor();
    await createProduct(
      a,
      { ...base, codigo: "CB17", nombre: "Rompecabezas", tipo_producto: "", codigo_barras_texto: "7501234567890" },
      [],
    );
    const results = await searchProducts("7501234567890", "codigo_barras");
    expect(results.map((p) => p.codigo)).toContain("CB17");
  });

  it("no encuentra por nombre ni por SKU bajo este filtro (a diferencia de 'todo')", async () => {
    const a = await actor();
    await createProduct(
      a,
      { ...base, codigo: "CB18", nombre: "Rompecabezas de madera", tipo_producto: "", codigo_barras_texto: "1112223334445" },
      [],
    );
    const porNombre = await searchProducts("Rompecabezas", "codigo_barras");
    expect(porNombre.map((p) => p.codigo)).not.toContain("CB18");
    const porSku = await searchProducts("CB18", "codigo_barras");
    expect(porSku.map((p) => p.codigo)).not.toContain("CB18");
  });
});
