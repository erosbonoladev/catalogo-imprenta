import { beforeEach, describe, expect, it } from "vitest";
import {
  createPlasticProduct,
  createProduct,
  createRemisionConFolio,
  getCatalogoProgreso,
  getReporteDiarioData,
  getSkuMasterExportData,
  savePlasticItems,
  updatePlasticProduct,
  listPlasticProductsSummary,
} from "../src/db";
import { buildReporteDiarioWorkbook, localDayRangeUtc, recetasSheetRows, reporteDiarioFileName } from "../src/excelExport";
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
    dimensiones_empaque: "",
    juegos_por_empaque: "",
    peso_empaque: "",
    volumen_empaque: "",
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
    maquila: "",
    coste: "",
    componentes_fabricacion: "",
    precio_por_pieza: "",
    precio_por_juego: "",
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
      sql: "INSERT INTO product_plastic_items (product_id, plastic_product_id, orden, cantidad) VALUES (?1, ?2, 1, '4')",
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
    expect(desgloseVinculado?.cantidad).toBe("4");

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

describe("getReporteDiarioData — avance del día (juegos agregados o modificados en el rango)", () => {
  const AYER = "2020-01-01 10:00:00";
  const RANGO = { desde: "2026-10-12 06:00:00", hasta: "2026-10-13 06:00:00" };
  const HOY = "2026-10-12 15:00:00";

  async function juegoConPieza(admin: Awaited<ReturnType<typeof actor>>, codigo: string, pieza: string) {
    const productId = await createProduct(admin, productInput(codigo, `Juego ${codigo}`), []);
    const piezaId = await createPlasticProduct(admin, piezaInput(pieza, `${codigo}-1`));
    await rawClient().execute({
      sql: "INSERT INTO product_plastic_items (product_id, plastic_product_id, orden, cantidad) VALUES (?1, ?2, 1, '1')",
      args: [productId, piezaId],
    });
    return { productId, piezaId };
  }

  async function fechar(productId: number, piezaId: number, productoEn: string, piezaEn: string) {
    await rawClient().execute({
      sql: "UPDATE products SET creado_en = ?1, actualizado_en = ?1 WHERE id = ?2",
      args: [productoEn, productId],
    });
    await rawClient().execute({
      sql: "UPDATE plastic_products SET creado_en = ?1, actualizado_en = NULL WHERE id = ?2",
      args: [piezaEn, piezaId],
    });
  }

  it("rechaza a un usuario sin sku_master", async () => {
    const a = await actor([]);
    await expect(getReporteDiarioData(a, RANGO.desde, RANGO.hasta)).rejects.toThrow(/no autorizado/i);
  });

  it("incluye un juego nuevo de hoy y deja fuera los que no se tocaron", async () => {
    const admin = await actor(["plasticos", "sku_master"]);
    const viejo = await juegoConPieza(admin, "1000", "Pieza vieja");
    const nuevo = await juegoConPieza(admin, "2000", "Pieza nueva");
    await fechar(viejo.productId, viejo.piezaId, AYER, AYER);
    await fechar(nuevo.productId, nuevo.piezaId, HOY, HOY);

    const data = await getReporteDiarioData(admin, RANGO.desde, RANGO.hasta);

    expect(data.productos.map((p) => p.codigo)).toEqual(["2000"]);
    expect(data.piezas.map((p) => p.producto_codigo)).toEqual(["2000"]);
  });

  it("si solo se modificó UNA pieza hoy, el juego aparece con todas sus piezas", async () => {
    const admin = await actor(["plasticos", "sku_master"]);
    const { productId, piezaId } = await juegoConPieza(admin, "3000", "Pieza A");
    const otraId = await createPlasticProduct(admin, piezaInput("Pieza B", "3000-2"));
    await rawClient().execute({
      sql: "INSERT INTO product_plastic_items (product_id, plastic_product_id, orden, cantidad) VALUES (?1, ?2, 2, '1')",
      args: [productId, otraId],
    });
    await fechar(productId, piezaId, AYER, AYER);
    await rawClient().execute({
      sql: "UPDATE plastic_products SET creado_en = ?1, actualizado_en = NULL WHERE id = ?2",
      args: [AYER, otraId],
    });
    await rawClient().execute({
      sql: "UPDATE plastic_products SET actualizado_en = ?1 WHERE id = ?2",
      args: [HOY, piezaId],
    });

    const data = await getReporteDiarioData(admin, RANGO.desde, RANGO.hasta);

    expect(data.piezas.map((p) => p.sku).sort()).toEqual(["3000-1", "3000-2"]);
  });

  it("updatePlasticProduct y savePlasticItems dejan huella de modificación (actualizado_en)", async () => {
    const admin = await actor(["plasticos", "sku_master"]);
    const { productId, piezaId } = await juegoConPieza(admin, "4000", "Pieza");
    await fechar(productId, piezaId, AYER, AYER);

    const hoy = new Date();
    const { desde, hasta } = localDayRangeUtc(hoy);
    expect((await getReporteDiarioData(admin, desde, hasta)).piezas).toHaveLength(0);

    await updatePlasticProduct(admin, piezaId, piezaInput("Pieza editada", "4000-1"));
    expect((await getReporteDiarioData(admin, desde, hasta)).piezas).toHaveLength(1);

    await fechar(productId, piezaId, AYER, AYER);
    await savePlasticItems(admin, productId, []);
    const data = await getReporteDiarioData(admin, desde, hasta);
    expect(data.productos.map((p) => p.codigo)).toEqual(["4000"]);
  });

  it("guardar una pieza sin cambios no la marca como modificada, pero cambiar un campo sí", async () => {
    const admin = await actor(["plasticos", "sku_master"]);
    const { productId, piezaId } = await juegoConPieza(admin, "5000", "Pieza");
    await fechar(productId, piezaId, AYER, AYER);
    const { desde, hasta } = localDayRangeUtc(new Date());

    await updatePlasticProduct(admin, piezaId, piezaInput("Pieza", "5000-1"));
    const fila = await rawClient().execute({
      sql: "SELECT actualizado_en FROM plastic_products WHERE id = ?1",
      args: [piezaId],
    });
    expect(fila.rows[0].actualizado_en).toBeNull();
    expect((await getReporteDiarioData(admin, desde, hasta)).piezas).toHaveLength(0);

    await updatePlasticProduct(admin, piezaId, { ...piezaInput("Pieza", "5000-1"), color: "Rojo" });
    expect((await getReporteDiarioData(admin, desde, hasta)).piezas).toHaveLength(1);
  });
});

describe("reporte diario — nombre de archivo y rango del día", () => {
  it("nombra Reporte dd_mm con ceros a la izquierda", () => {
    expect(reporteDiarioFileName(new Date(2026, 9, 12))).toBe("Reporte 12_10.xlsx");
    expect(reporteDiarioFileName(new Date(2026, 0, 5))).toBe("Reporte 05_01.xlsx");
  });

  it("el rango cubre exactamente 24 h locales como texto UTC comparable", () => {
    const { desde, hasta } = localDayRangeUtc(new Date(2026, 9, 12, 15, 30));
    expect(desde).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(hasta > desde).toBe(true);
  });

  it("arma un xlsx con los mismos encabezados que Recetas", () => {
    const bytes = buildReporteDiarioWorkbook({ productos: [], piezas: [], precios: [] });
    expect(bytes.length).toBeGreaterThan(0);
    expect(recetasSheetRows([], [], [])[0][0]).toBe("SKU Principal");
  });
});

describe("getCatalogoProgreso — fichas sin piezas / sin precios de venta", () => {
  it("rechaza a un usuario sin sku_master", async () => {
    const a = await actor([]);
    await expect(getCatalogoProgreso(a)).rejects.toThrow(/no autorizado/i);
  });

  it("cuenta como faltantes las fichas sin piezas y las sin ningún precio de venta con valor", async () => {
    const admin = await actor(["plasticos", "sku_master"]);
    const conTodo = await createProduct(admin, productInput("1", "Completo"), []);
    const soloPiezas = await createProduct(admin, productInput("2", "Solo piezas"), []);
    const preciosNulos = await createProduct(admin, productInput("3", "Precio por definir"), []);
    const piezaId = await createPlasticProduct(admin, piezaInput("P", "1-1"));
    for (const id of [conTodo, soloPiezas]) {
      await rawClient().execute({
        sql: "INSERT INTO product_plastic_items (product_id, plastic_product_id, orden, cantidad) VALUES (?1, ?2, 1, '1')",
        args: [id, piezaId],
      });
    }
    await rawClient().execute({
      sql: "INSERT INTO precios_venta (product_id, categoria, precio) VALUES (?1, 'Gobierno', 10), (?2, 'Gobierno', NULL)",
      args: [conTodo, preciosNulos],
    });

    const progreso = await getCatalogoProgreso(admin);

    expect(progreso.total).toBe(3);
    expect(progreso.sinPiezas).toEqual([preciosNulos]);
    expect(progreso.sinPreciosVenta).toEqual([soloPiezas, preciosNulos]);
  });
});
