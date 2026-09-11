import { beforeEach, describe, expect, it } from "vitest";
import { createProduct, getProduct, updateProduct } from "../src/db";
import { TIPOS_PRODUCTO } from "../src/types";
import { createFixtureUser, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

async function actor() {
  return createFixtureUser({ username: `u-${Math.random().toString(36).slice(2)}`, permisos: [] });
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
