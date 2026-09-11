import { beforeEach, describe, expect, it } from "vitest";
import {
  createPlasticProduct,
  createProduct,
  createRemisionConFolio,
  getSkuMasterExportData,
  listPlasticProductsSummary,
} from "../src/db";
import { createFixtureUser, rawClient, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

function productInput(codigo: string, nombre: string) {
  return {
    codigo,
    nombre,
    categoria: "",
    material: "",
    descripcion: "",
    imagen: null,
    imagen_codigo_barras: null,
    tipo_producto: "",
    codigo_barras_texto: "",
  };
}

function piezaInput(nombre: string, sku: string) {
  return {
    nombre,
    sku,
    color: "",
    origen: "",
    descripcion: "",
    material: "",
    dimension: "",
    peso: "",
    tipo_empaque: "",
    maquila: "",
    coste: "",
    componentes_fabricacion: "",
    dimensiones_empaque: "",
    imagen: { data: new Uint8Array([1, 2, 3]), mime: "image/png" },
  };
}

async function actor(permisos: string[]) {
  return createFixtureUser({ username: `u-${Math.random().toString(36).slice(2)}`, permisos });
}

describe("listPlasticProductsSummary — lista liviana para pantallas que no muestran imagen (PiezasGeneralSection/SkuMasterSection)", () => {
  it("no trae la imagen aunque la pieza tenga una, pero sí el resto de columnas", async () => {
    const a = await actor(["plasticos"]);
    await createPlasticProduct(a, piezaInput("Pieza con imagen", "PZ1"));

    const list = await listPlasticProductsSummary();

    expect(list).toHaveLength(1);
    expect(list[0].sku).toBe("PZ1");
    expect(list[0].nombre).toBe("Pieza con imagen");
    expect(list[0].imagen).toBeNull();
  });
});

describe("getSkuMasterExportData — autorización server-side", () => {
  it("rechaza a un usuario sin el permiso sku_master", async () => {
    const a = await actor([]);
    await expect(getSkuMasterExportData(a)).rejects.toThrow(/no autorizado/i);
  });

  it("acepta a un usuario con sku_master", async () => {
    const a = await actor(["sku_master"]);
    await expect(getSkuMasterExportData(a)).resolves.toBeDefined();
  });
});

describe("getSkuMasterExportData — reúne productos, desglose de piezas, precios y remisiones sin perder relaciones", () => {
  it("incluye una pieza vinculada a su producto y una pieza suelta sin inventar la relación", async () => {
    const admin = await actor(["plasticos", "sku_master", "remisiones_crear"]);
    const productId = await createProduct(admin, productInput("9001", "Juego X"), []);
    const piezaVinculadaId = await createPlasticProduct(admin, piezaInput("Pieza vinculada", "9001-1"));
    await createPlasticProduct(admin, piezaInput("Pieza suelta", "8080"));

    await rawClient().execute({
      sql: "INSERT INTO product_plastic_items (product_id, plastic_product_id, orden) VALUES (?1, ?2, 1)",
      args: [productId, piezaVinculadaId],
    });
    await rawClient().execute({
      sql: "INSERT INTO precios (sku, sku_principal, nombre, precio) VALUES ('9001', '9001', 'Juego X', 199.5)",
      args: [],
    });
    await createRemisionConFolio(
      admin,
      "9001",
      { fecha: "2026-09-10", tipo: "interna", pedido_bodegas: "JALISCO", descuento_pct: 0 },
      [{ sku: "9001", producto_nombre: "Juego X", cantidad: 2, precio_unitario: 199.5, importe: 399 }],
    );

    const data = await getSkuMasterExportData(admin);

    expect(data.productos.map((p) => p.codigo)).toContain("9001");

    const desgloseVinculado = data.piezas.find((p) => p.sku === "9001-1");
    expect(desgloseVinculado?.producto_codigo).toBe("9001");
    expect(desgloseVinculado?.orden).toBe(1);

    // La pieza sin ficha vinculada no se omite ni se le inventa un producto —
    // aparece con las columnas de producto en null (ver LEFT JOIN en db.ts).
    const desgloseSuelto = data.piezas.find((p) => p.sku === "8080");
    expect(desgloseSuelto).toBeDefined();
    expect(desgloseSuelto?.producto_codigo).toBeNull();
    expect(desgloseSuelto?.producto_nombre).toBeNull();

    expect(data.precios.find((p) => p.sku === "9001")?.precio).toBe(199.5);

    const renglon = data.remisiones.find((r) => r.sku === "9001");
    expect(renglon?.pedido_bodegas).toBe("JALISCO");
    expect(renglon?.cantidad).toBe(2);
    expect(renglon?.folio).toMatch(/\S+/);
  });
});
