import { beforeEach, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  SIN_RELACION_MOTIVO,
  SIN_SKU_MOTIVO,
  buildMaderaInput,
  classifyMaderaRows,
  parseMoneyField,
  readMaderaWorkbook,
  type MaderaRowLookup,
  type RawMaderaImportRow,
} from "../src/maderaImport";
import {
  findWoodProductInJuegoByNombreTamano,
  getLastMaderaImportBatch,
  importWoodRow,
  recordMaderaImportBatch,
  undoLastMaderaImportBatch,
} from "../src/db";
import { countRows, createFixtureUser, rawClient, resetDb } from "./helpers";
import type { Product, WoodProduct } from "../src/types";

beforeEach(async () => {
  await resetDb();
});

function makeRow(overrides: Partial<RawMaderaImportRow> = {}): RawMaderaImportRow {
  return {
    fila: 2,
    nombre: "Alinia y Combina Madera",
    sku: "1138",
    tamano: "14.4 x 20",
    capas: "1",
    largo: "28",
    ancho: "67",
    espesor: "2.5",
    cabenHojaMdf: "13",
    minutosLaser: "5",
    importeMadera: "9.23",
    pintura: "",
    importeCorteLaser: "25",
    etiquetaAdhesiva: "12.3",
    otroImporte: "",
    otroConcepto: "",
    etiquetaEmpaque: "2",
    costoTotal: "48.53",
    precioVenta: "53.38",
    ...overrides,
  };
}

function makeJuego(overrides: Partial<Product> = {}): Product {
  return {
    id: 1,
    codigo: "1138",
    nombre: "Juego de prueba",
    categoria: "",
    material: "",
    descripcion: "",
    imagen: null,
    imagen_codigo_barras: null,
    presentacion_original: "",
    creado_en: "",
    actualizado_en: "",
    ...overrides,
  };
}

function makeWoodProduct(overrides: Partial<WoodProduct> = {}): WoodProduct {
  return {
    id: 10,
    nombre: "Alinia y Combina Madera",
    sku: "1138",
    tamano: "14.4 x 20",
    capas: "1",
    largo: "28",
    ancho: "67",
    espesor: "2.5",
    caben_hoja_mdf: "13",
    minutos_laser: "5",
    importe_madera: 9.23,
    pintura: null,
    importe_corte_laser: 25,
    etiqueta_adhesiva: 12.3,
    otro_importe: null,
    otro_concepto: "",
    etiqueta_empaque: 2,
    costo_total: 48.53,
    precio_venta: 53.38,
    imagen: null,
    creado_en: "",
    ...overrides,
  };
}

// --- parseMoneyField ---

describe("parseMoneyField", () => {
  it("celda vacía -> sin valor (null), no bloquea", () => {
    expect(parseMoneyField("")).toEqual({ ok: true, value: null });
    expect(parseMoneyField("   ")).toEqual({ ok: true, value: null });
  });

  it("número válido -> ok con el valor parseado", () => {
    expect(parseMoneyField("15")).toEqual({ ok: true, value: 15 });
    expect(parseMoneyField("82.555")).toEqual({ ok: true, value: 82.555 });
  });

  it("texto no numérico -> inválido (caso real del archivo: 'Caja' en Precio venta)", () => {
    expect(parseMoneyField("Caja").ok).toBe(false);
    expect(parseMoneyField("tablero").ok).toBe(false);
    expect(parseMoneyField("2a parte").ok).toBe(false);
  });
});

// --- readMaderaWorkbook ---

describe("readMaderaWorkbook", () => {
  // Encabezados reales del archivo del usuario ("Precios Madera Abril
  // 26.xlsx"): typos ("cabenen", "lasser"), una columna de espesor
  // duplicada ("espesor de la madera en mm", se ignora) y columnas finales
  // redundantes (QUE ES OTRO sí se usa, INSTRUCTIVO/PRODUCTO/CLAVE/PRECIO
  // se ignoran).
  const REAL_HEADERS = [
    "Producto",
    "SKU",
    "Tamaño",
    "capas",
    "Largo",
    "Ancho",
    "espesor de la madera",
    "cabenen en una hoja de MDF 122 x 244",
    "espesor de la madera en mm",
    "Minutos en laser",
    "",
    "importe Madera",
    "Pintura",
    "Importe Corte lasser",
    "Etiqueta adhesiva",
    "Otro",
    "etiqueta empaque",
    "Costo total",
    "precio venta",
    "QUE ES OTRO",
    "INSTRUCTIVO",
    "PRODUCTO",
    "CLAVE",
    "PRECIO",
  ];

  function buildXlsx(rows: (string | number)[][]): Uint8Array {
    const sheet = XLSX.utils.aoa_to_sheet([REAL_HEADERS, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
    return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
  }

  it("lee una fila real (misma forma que el archivo del usuario) y separa Otro de QUE ES OTRO", () => {
    const bytes = buildXlsx([
      [
        "Alfabeto Pesca Madera (42 Piezas en caja y caña)",
        2233,
        "6x35",
        1,
        33,
        48,
        2.5,
        14,
        2.5,
        5,
        "",
        8.571428571428571,
        "",
        25,
        10.11,
        8,
        2,
        53.68142857142857,
        112.43341758241758,
        "imán y armado $ 16.50",
        "",
        "Alfabeto Pesca Madera (42 Piezas en caja y caña)",
        2233,
        112.43341758241758,
      ],
    ]);
    const result = readMaderaWorkbook(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      nombre: "Alfabeto Pesca Madera (42 Piezas en caja y caña)",
      sku: "2233",
      tamano: "6x35",
      capas: "1",
      otroImporte: "8",
      otroConcepto: "imán y armado $ 16.50",
    });
  });

  it("ignora la columna de espesor duplicada ('en mm') y toma la primera ('espesor de la madera')", () => {
    const bytes = buildXlsx([
      [
        "Base de Madera",
        4054,
        "20.4 x 28.7",
        2,
        24,
        33,
        "5.5 y 2.5",
        27,
        2.5,
        4.5,
        "",
        11.9,
        "",
        22.5,
        15,
        "",
        2,
        51.4,
        61.9,
        "",
        "",
        "",
        "",
        "",
      ],
    ]);
    const result = readMaderaWorkbook(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // El espesor real combina dos valores — se conserva tal cual, no se
    // fuerza a número.
    expect(result.rows[0].espesor).toBe("5.5 y 2.5");
  });

  it("ignora filas totalmente en blanco (pie de página del archivo real)", () => {
    const bytes = buildXlsx([
      ["", "", "Precios MDF Abril 26", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
      ["Producto real", 1000, "10x10", 1, 10, 10, 2.5, 10, 2.5, 2, "", 5, "", 5, 2, "", 1, 13, 15, "", "", "", "", ""],
    ]);
    const result = readMaderaWorkbook(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // La fila de "Precios MDF Abril 26" no está en blanco (trae texto en
    // Tamaño), así que sí se lee como fila — pero sin Producto, se
    // clasificará como error más adelante, no se descarta aquí.
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].nombre).toBe("");
  });

  it("reporta encabezados faltantes", () => {
    const sheet = XLSX.utils.aoa_to_sheet([["Producto", "SKU"], ["x", "1000"]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    const result = readMaderaWorkbook(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missingHeaders).toContain("Tamaño");
    expect(result.missingHeaders).toContain("Costo total");
  });
});

// --- classifyMaderaRows ---

describe("classifyMaderaRows", () => {
  it("juego resuelto, producto nuevo (sin match por nombre+tamaño) -> nueva", () => {
    const row = makeRow();
    const lookups = new Map<number, MaderaRowLookup>([[row.fila, { juego: makeJuego(), wood: null }]]);
    const [result] = classifyMaderaRows([row], lookups);
    expect(result.status).toBe("nueva");
    expect(result.matchedJuego?.codigo).toBe("1138");
  });

  it("ya existe un producto de madera con ese nombre+tamaño en ese juego -> actualizar", () => {
    const row = makeRow();
    const wood = makeWoodProduct();
    const lookups = new Map<number, MaderaRowLookup>([[row.fila, { juego: makeJuego(), wood }]]);
    const [result] = classifyMaderaRows([row], lookups);
    expect(result.status).toBe("actualizar");
    expect(result.matchedWoodProduct?.id).toBe(10);
  });

  it("falta Producto -> error", () => {
    const row = makeRow({ nombre: "" });
    const [result] = classifyMaderaRows([row], new Map());
    expect(result.status).toBe("error");
    expect(result.reason).toMatch(/Producto/);
  });

  it("sin SKU -> sin-relacion con el motivo fijo", () => {
    const row = makeRow({ sku: "" });
    const [result] = classifyMaderaRows([row], new Map());
    expect(result.status).toBe("sin-relacion");
    expect(result.reason).toBe(SIN_SKU_MOTIVO);
  });

  it("SKU sin producto/juego coincidente -> sin-relacion con el motivo fijo", () => {
    const row = makeRow();
    const lookups = new Map<number, MaderaRowLookup>([[row.fila, { juego: null, wood: null }]]);
    const [result] = classifyMaderaRows([row], lookups);
    expect(result.status).toBe("sin-relacion");
    expect(result.reason).toBe(SIN_RELACION_MOTIVO);
  });

  it("un campo de dinero con texto no numérico -> error (ej. 'Caja' en Precio venta, caso real)", () => {
    const row = makeRow({ precioVenta: "Caja" });
    const lookups = new Map<number, MaderaRowLookup>([[row.fila, { juego: makeJuego(), wood: null }]]);
    const [result] = classifyMaderaRows([row], lookups);
    expect(result.status).toBe("error");
    expect(result.reason).toMatch(/Precio venta/);
  });

  it("un campo de dinero vacío no bloquea la fila (ej. Pintura vacía es normal)", () => {
    const row = makeRow({ pintura: "" });
    const lookups = new Map<number, MaderaRowLookup>([[row.fila, { juego: makeJuego(), wood: null }]]);
    const [result] = classifyMaderaRows([row], lookups);
    expect(result.status).toBe("nueva");
  });

  it("mismo SKU (juego), mismo nombre, Tamaño distinto -> dos filas 'nueva' separadas (caso real: SKU 4054 con dos piezas)", () => {
    const juego = makeJuego({ id: 5, codigo: "4054" });
    const rowA = makeRow({ fila: 2, sku: "4054", nombre: "Base Laberinto", tamano: "20.4 x 28.7" });
    const rowB = makeRow({ fila: 3, sku: "4054", nombre: "Base Laberinto", tamano: "19.9 x 28.2" });
    const lookups = new Map<number, MaderaRowLookup>([
      [2, { juego, wood: null }],
      [3, { juego, wood: null }],
    ]);
    const results = classifyMaderaRows([rowA, rowB], lookups);
    expect(results[0].status).toBe("nueva");
    expect(results[1].status).toBe("nueva");
  });

  it("mismo juego, mismo nombre Y mismo tamaño repetido en el archivo -> error en la segunda ocurrencia", () => {
    const juego = makeJuego();
    const rowA = makeRow({ fila: 2 });
    const rowB = makeRow({ fila: 3 });
    const lookups = new Map<number, MaderaRowLookup>([
      [2, { juego, wood: null }],
      [3, { juego, wood: null }],
    ]);
    const results = classifyMaderaRows([rowA, rowB], lookups);
    expect(results[0].status).toBe("nueva");
    expect(results[1].status).toBe("error");
    expect(results[1].reason).toMatch(/duplicada/);
  });

  it("mismo nombre+tamaño repetido entre filas 'sin-relacion' NO se marca como error", () => {
    const rowA = makeRow({ fila: 2, sku: "" });
    const rowB = makeRow({ fila: 3, sku: "" });
    const results = classifyMaderaRows([rowA, rowB], new Map());
    expect(results[0].status).toBe("sin-relacion");
    expect(results[1].status).toBe("sin-relacion");
  });
});

// --- buildMaderaInput ---

describe("buildMaderaInput", () => {
  it("parsea los campos de dinero a número y conserva el resto como texto", () => {
    const row = makeRow();
    const [classified] = classifyMaderaRows([row], new Map([[row.fila, { juego: makeJuego(), wood: null }]]));
    const input = buildMaderaInput(classified);
    expect(input.nombre).toBe("Alinia y Combina Madera");
    expect(input.tamano).toBe("14.4 x 20");
    expect(input.importe_madera).toBe(9.23);
    expect(input.pintura).toBeNull();
    expect(input.costo_total).toBe(48.53);
  });

  it("guarda el concepto de Otro por separado del importe", () => {
    const row = makeRow({ otroImporte: "8", otroConcepto: "imán y armado $ 16.50" });
    const [classified] = classifyMaderaRows([row], new Map([[row.fila, { juego: makeJuego(), wood: null }]]));
    const input = buildMaderaInput(classified);
    expect(input.otro_importe).toBe(8);
    expect(input.otro_concepto).toBe("imán y armado $ 16.50");
  });

  it("en un alta nueva, imagen queda vacía (el Excel no trae fotos)", () => {
    const row = makeRow();
    const [classified] = classifyMaderaRows([row], new Map([[row.fila, { juego: makeJuego(), wood: null }]]));
    const input = buildMaderaInput(classified);
    expect(input.imagen).toBeNull();
  });

  it("en una actualización preserva la imagen del registro existente (el Excel no la trae)", () => {
    const row = makeRow();
    const wood = makeWoodProduct({ imagen: { data: new Uint8Array([1, 2, 3]), mime: "image/png" } });
    const [classified] = classifyMaderaRows([row], new Map([[row.fila, { juego: makeJuego(), wood }]]));
    const input = buildMaderaInput(classified);
    expect(input.imagen).toEqual({ data: new Uint8Array([1, 2, 3]), mime: "image/png" });
  });
});

// --- findWoodProductInJuegoByNombreTamano / importWoodRow (integración contra BD) ---

describe("findWoodProductInJuegoByNombreTamano + importWoodRow", () => {
  async function seedJuego(codigo: string): Promise<number> {
    const client = rawClient();
    const result = await client.execute({
      sql: "INSERT INTO products (codigo, nombre) VALUES (?1, ?2)",
      args: [codigo, `Juego ${codigo}`],
    });
    return Number(result.lastInsertRowid);
  }

  it("crea un producto de madera nuevo y su relación con el juego", async () => {
    const actor = await createFixtureUser({ username: "u1", permisos: ["maderas"] });
    const productId = await seedJuego("1138");

    const [classified] = classifyMaderaRows(
      [makeRow()],
      new Map([[2, { juego: makeJuego({ id: productId, codigo: "1138" }), wood: null }]]),
    );
    const input = buildMaderaInput(classified);
    const woodId = await importWoodRow(actor, productId, null, input, 1);

    const wood = await rawClient().execute({
      sql: "SELECT * FROM wood_products WHERE id = ?1",
      args: [woodId],
    });
    expect(wood.rows).toHaveLength(1);

    const rel = await rawClient().execute({
      sql: "SELECT * FROM product_wood_items WHERE product_id = ?1 AND wood_product_id = ?2",
      args: [productId, woodId],
    });
    expect(rel.rows).toHaveLength(1);
  });

  it("actualiza un producto existente (mismo nombre+tamaño en el mismo juego) sin duplicar la relación", async () => {
    const actor = await createFixtureUser({ username: "u2", permisos: ["maderas"] });
    const productId = await seedJuego("1138");

    const [classified] = classifyMaderaRows(
      [makeRow()],
      new Map([[2, { juego: makeJuego({ id: productId, codigo: "1138" }), wood: null }]]),
    );
    const input = buildMaderaInput(classified);
    const woodId = await importWoodRow(actor, productId, null, input, 1);

    const found = await findWoodProductInJuegoByNombreTamano("Alinia y Combina Madera", "14.4 x 20", productId);
    expect(found?.id).toBe(woodId);

    const updatedInput = { ...input, costo_total: 999 };
    await importWoodRow(actor, productId, woodId, updatedInput, 1);

    const rel = await rawClient().execute({
      sql: "SELECT * FROM product_wood_items WHERE product_id = ?1",
      args: [productId],
    });
    expect(rel.rows).toHaveLength(1);

    const wood = await rawClient().execute({
      sql: "SELECT costo_total FROM wood_products WHERE id = ?1",
      args: [woodId],
    });
    expect((wood.rows[0] as unknown as { costo_total: number }).costo_total).toBe(999);
  });

  it("findWoodProductInJuegoByNombreTamano no confunde el mismo nombre+tamaño en otro juego", async () => {
    const actor = await createFixtureUser({ username: "u3", permisos: ["maderas"] });
    const productA = await seedJuego("1138");
    const productB = await seedJuego("9999");

    const [classified] = classifyMaderaRows(
      [makeRow()],
      new Map([[2, { juego: makeJuego({ id: productA, codigo: "1138" }), wood: null }]]),
    );
    const input = buildMaderaInput(classified);
    await importWoodRow(actor, productA, null, input, 1);

    const foundInB = await findWoodProductInJuegoByNombreTamano("Alinia y Combina Madera", "14.4 x 20", productB);
    expect(foundInB).toBeNull();
  });

  it("exige el permiso 'maderas'", async () => {
    const actor = await createFixtureUser({ username: "sin-permiso", permisos: [] });
    const productId = await seedJuego("9000");
    const [classified] = classifyMaderaRows(
      [makeRow()],
      new Map([[2, { juego: makeJuego({ id: productId, codigo: "9000" }), wood: null }]]),
    );
    const input = buildMaderaInput(classified);
    await expect(importWoodRow(actor, productId, null, input, 1)).rejects.toThrow();
  });
});

// --- Maderas "sin relación" (sin juego) ---

describe("importWoodRow con productId null (maderas sin relación a un juego)", () => {
  it("crea el producto en el catálogo maestro sin fila en product_wood_items", async () => {
    const actor = await createFixtureUser({ username: "u4", permisos: ["maderas"] });
    const [classified] = classifyMaderaRows([makeRow({ sku: "" })], new Map());
    const input = buildMaderaInput(classified);
    const woodId = await importWoodRow(actor, null, null, input, 0);

    const wood = await rawClient().execute({
      sql: "SELECT * FROM wood_products WHERE id = ?1",
      args: [woodId],
    });
    expect(wood.rows).toHaveLength(1);

    const rel = await rawClient().execute({
      sql: "SELECT * FROM product_wood_items WHERE wood_product_id = ?1",
      args: [woodId],
    });
    expect(rel.rows).toHaveLength(0);
  });
});

// --- Lotes de importación (registrar / consultar / deshacer) ---

describe("recordMaderaImportBatch + getLastMaderaImportBatch + undoLastMaderaImportBatch", () => {
  it("no crea ningún lote si la lista de IDs viene vacía", async () => {
    const actor = await createFixtureUser({ username: "u6", permisos: ["maderas"] });
    await recordMaderaImportBatch(actor, []);
    expect(await getLastMaderaImportBatch()).toBeNull();
  });

  it("registra un lote y lo devuelve como el último; deshacerlo borra exactamente esos productos", async () => {
    const actor = await createFixtureUser({ username: "u7", permisos: ["maderas"] });
    const productId = await seedJuegoStandalone("7777");

    const [classified] = classifyMaderaRows(
      [makeRow({ sku: "7777" })],
      new Map([[2, { juego: makeJuego({ id: productId, codigo: "7777" }), wood: null }]]),
    );
    const input = buildMaderaInput(classified);
    const idA = await importWoodRow(actor, productId, null, input, 1);
    const idB = await importWoodRow(actor, null, null, { ...input, nombre: "sin relación" }, 0);

    await recordMaderaImportBatch(actor, [idA, idB]);

    const last = await getLastMaderaImportBatch();
    expect(last?.total).toBe(2);
    expect(last?.creado_por).toBe("u7");

    const { eliminadas } = await undoLastMaderaImportBatch(actor);
    expect(eliminadas).toBe(2);

    expect(await countRows("wood_products", "id = ?1", [idA])).toBe(0);
    expect(await countRows("wood_products", "id = ?1", [idB])).toBe(0);
    expect(await countRows("product_wood_items", "wood_product_id = ?1", [idA])).toBe(0);

    expect(await getLastMaderaImportBatch()).toBeNull();
    await expect(undoLastMaderaImportBatch(actor)).rejects.toThrow();
  });

  it("exige el permiso 'maderas' para deshacer", async () => {
    const actor = await createFixtureUser({ username: "sin-permiso-2", permisos: [] });
    await expect(undoLastMaderaImportBatch(actor)).rejects.toThrow();
  });

  async function seedJuegoStandalone(codigo: string): Promise<number> {
    const result = await rawClient().execute({
      sql: "INSERT INTO products (codigo, nombre) VALUES (?1, ?2)",
      args: [codigo, `Juego ${codigo}`],
    });
    return Number(result.lastInsertRowid);
  }
});
