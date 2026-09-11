import { beforeEach, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  SIN_JUEGO_PREVIO_MOTIVO,
  SIN_RELACION_MOTIVO,
  buildImageLinkCandidates,
  buildPiezaInput,
  classifyPiezaRows,
  normalizeImageLink,
  readPiezasWorkbook,
  type PiezaRowLookup,
  type RawPiezaImportRow,
} from "../src/piezasImport";
import {
  findPlasticProductInJuegoByNombre,
  findPlasticProductInJuegoBySku,
  getLastPiezaImportBatch,
  importPiezaRow,
  recordPiezaImportBatch,
  undoLastPiezaImportBatch,
} from "../src/db";
import { countRows, createFixtureUser, rawClient, resetDb } from "./helpers";
import type { PlasticProduct, Product } from "../src/types";

beforeEach(async () => {
  await resetDb();
});

function makeRow(overrides: Partial<RawPiezaImportRow> = {}): RawPiezaImportRow {
  return {
    fila: 3,
    juegoSku: "7234",
    sku: "",
    origen: "BOD",
    descripcion: "Tubo 2\"",
    componentesFabricacion: "6",
    dimension: "",
    peso: "308.4",
    maquila: "5.00",
    coste: "30.84",
    dimensionesEmpaque: "",
    linkImagen: "",
    ...overrides,
  };
}

function makeJuego(overrides: Partial<Product> = {}): Product {
  return {
    id: 1,
    codigo: "7234",
    nombre: "Juego de prueba",
    categoria: "",
    material: "",
    descripcion: "",
    imagen: null,
    imagen_codigo_barras: null,
    tipo_producto: "",
    codigo_barras_texto: "",
    presentacion_original: "",
    creado_en: "",
    actualizado_en: "",
    ...overrides,
  };
}

function makePieza(overrides: Partial<PlasticProduct> = {}): PlasticProduct {
  return {
    id: 10,
    nombre: "Tubo 2\"",
    sku: "",
    color: "Rojo",
    origen: "BOD",
    descripcion: "Tubo 2\"",
    material: "ABS",
    dimension: "",
    peso: "308.4",
    tipo_empaque: "Caja",
    maquila: "5.00",
    coste: "30.84",
    componentes_fabricacion: "6",
    dimensiones_empaque: "",
    imagen: null,
    creado_en: "",
    ...overrides,
  };
}

// --- normalizeImageLink ---

describe("buildImageLinkCandidates", () => {
  it("un link de compartir de Drive (/file/d/<ID>/view) da 3 variantes, miniatura primero", () => {
    const raw = "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing";
    expect(buildImageLinkCandidates(raw)).toEqual([
      "https://drive.google.com/thumbnail?id=1AbCdEfGhIjKlMnOp&sz=w1600",
      "https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOp",
      "https://lh3.googleusercontent.com/d/1AbCdEfGhIjKlMnOp",
    ]);
  });

  it("un link con ?id=<ID> da las mismas 3 variantes", () => {
    const raw = "https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp";
    expect(buildImageLinkCandidates(raw)[0]).toBe(
      "https://drive.google.com/thumbnail?id=1AbCdEfGhIjKlMnOp&sz=w1600",
    );
  });

  it("el link real reportado por el usuario genera las variantes esperadas", () => {
    const raw = "https://drive.google.com/file/d/1rlAwsYbaIQC_H41aEpCB1NOtDBCsJOkG/view";
    expect(buildImageLinkCandidates(raw)).toEqual([
      "https://drive.google.com/thumbnail?id=1rlAwsYbaIQC_H41aEpCB1NOtDBCsJOkG&sz=w1600",
      "https://drive.google.com/uc?export=download&id=1rlAwsYbaIQC_H41aEpCB1NOtDBCsJOkG",
      "https://lh3.googleusercontent.com/d/1rlAwsYbaIQC_H41aEpCB1NOtDBCsJOkG",
    ]);
  });

  it("un link ya directo de googleusercontent.com se usa tal cual, sin variantes", () => {
    const raw = "https://lh3.googleusercontent.com/d/1AbCdEfGhIjKlMnOp";
    expect(buildImageLinkCandidates(raw)).toEqual([raw]);
  });

  it("texto sin URL da lista vacía", () => {
    expect(buildImageLinkCandidates("sin link aquí")).toEqual([]);
    expect(buildImageLinkCandidates("")).toEqual([]);
  });
});

describe("normalizeImageLink", () => {
  it("devuelve la primera variante (miniatura) cuando hay un link de Drive utilizable", () => {
    const raw = "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view";
    expect(normalizeImageLink(raw)).toBe(
      "https://drive.google.com/thumbnail?id=1AbCdEfGhIjKlMnOp&sz=w1600",
    );
  });

  it("texto sin URL da null", () => {
    expect(normalizeImageLink("sin link aquí")).toBeNull();
    expect(normalizeImageLink("")).toBeNull();
  });
});

// --- readPiezasWorkbook ---

describe("readPiezasWorkbook", () => {
  // Encabezados reales del archivo del usuario: IMAGEN (se ignora, no forma
  // parte de las columnas reconocidas) + las 10 columnas relevantes + NETO
  // PROD (también se ignora).
  const REAL_HEADERS = [
    "IMAGEN",
    "ORIGEN",
    "SKU",
    "Descripción",
    "COMPONENTES DE FABRICACION",
    "Dimensiones",
    "PESO (GR.)",
    "MAQUILA",
    "COSTO",
    "NETO PROD",
    "DIMENSIONES EMPAQUE",
    "LINKS IMAGENES PIEZAS",
  ];

  function buildXlsx(rows: (string | number)[][]): Uint8Array {
    const sheet = XLSX.utils.aoa_to_sheet([REAL_HEADERS, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Piezas");
    return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
  }

  it("agrupa por bloques: la fila con SKU es el juego (no se importa), las filas sin SKU debajo son sus piezas", () => {
    const bytes = buildXlsx([
      ["", "", "1042", "PORTA LIBROS", "17", "", "3410", "", "477.80", "", "", ""],
      ["", "BOD", "", "Tela porta libro", "1", "", "955", "", "220.00", "", "", ""],
      ["", "BOD", "", "Codo 90° 2\"", "6", "", "308.4", "", "30.84", "", "", ""],
      ["", "", "1043", "OTRO JUEGO", "", "", "", "", "", "", "", ""],
      ["", "GIL", "", "Tee 2\"", "3", "", "237.6", "", "23.76", "", "", ""],
    ]);
    const result = readPiezasWorkbook(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Las dos filas de juego (1042, 1043) no aparecen como piezas.
    expect(result.rows).toHaveLength(3);
    expect(result.rows.every((r) => r.descripcion !== "PORTA LIBROS" && r.descripcion !== "OTRO JUEGO")).toBe(true);

    expect(result.rows[0]).toMatchObject({ juegoSku: "1042", descripcion: "Tela porta libro" });
    expect(result.rows[1]).toMatchObject({ juegoSku: "1042", descripcion: 'Codo 90° 2"' });
    // La tercera pieza está debajo de la segunda fila de juego (1043).
    expect(result.rows[2]).toMatchObject({ juegoSku: "1043", descripcion: 'Tee 2"' });
  });

  it("una fila de pieza antes de cualquier fila de juego queda con juegoSku vacío", () => {
    const bytes = buildXlsx([
      ["", "BOD", "", "Pieza huérfana", "1", "", "10", "", "1.00", "", "", ""],
      ["", "", "1000", "JUEGO", "", "", "", "", "", "", "", ""],
    ]);
    const result = readPiezasWorkbook(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].juegoSku).toBe("");
  });

  it("propaga una celda combinada (Maquila fusionada verticalmente sobre las piezas de un juego)", () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      REAL_HEADERS,
      ["", "", "1000", "JUEGO", "", "", "", "", "", "", "", ""],
      ["", "BOD", "", "Pieza uno", "1", "", "10", "5.00", "1.00", "", "", ""],
      ["", "BOD", "", "Pieza dos", "1", "", "10", "", "1.00", "", "", ""],
      ["", "BOD", "", "Pieza tres", "1", "", "10", "", "1.00", "", "", ""],
    ]);
    // Fusiona la columna MAQUILA (índice 7) desde la fila 2 (0-based, la
    // primera pieza) hasta la fila 4 (la última pieza) — igual que el
    // archivo real, donde "$5.00" se ve una sola vez abarcando el bloque.
    sheet["!merges"] = [{ s: { r: 2, c: 7 }, e: { r: 4, c: 7 } }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Piezas");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);

    const result = readPiezasWorkbook(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(3);
    expect(result.rows.map((r) => r.maquila)).toEqual(["5.00", "5.00", "5.00"]);
  });

  it("distingue 'Dimensiones' de 'DIMENSIONES EMPAQUE'", () => {
    const bytes = buildXlsx([
      ["", "", "1000", "JUEGO", "", "PIEZA-10x5", "", "", "", "", "EMPAQUE-30x20", ""],
      ["", "BOD", "", "Pieza uno", "1", "5x5", "10", "", "1.00", "", "10x10", ""],
    ]);
    const result = readPiezasWorkbook(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].dimension).toBe("5x5");
    expect(result.rows[0].dimensionesEmpaque).toBe("10x10");
  });

  it("una pieza con SKU propio (con guion) no se confunde con una fila de juego nueva", () => {
    const bytes = buildXlsx([
      ["", "", "1138", "ALINEA Y COMBINA", "48", "25 x 25", "0.258", "", "", "", "", ""],
      ["", "IMP", "1138-1", "Base alinea y combina", "1", "24.5 x 20 x .25", "0.076", "", "0.076", "", "", ""],
      // Pieza reutilizada de otro contexto — el prefijo "3346" no coincide
      // con el juego "1138", pero como SÍ tiene guion, sigue siendo pieza
      // del bloque actual, no una fila de juego nueva.
      ["", "BOD", "3346-17", "Ficha para contar chica azul", "5", "2.3 x 2", "0.005", "", "0.005", "", "", ""],
      // Pieza sin SKU propio, como en los ejemplos anteriores.
      ["", "IMP", "", "Etiqueta base", "1", "34.5 x 20", "", "", "", "", "", ""],
    ]);
    const result = readPiezasWorkbook(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(3);
    expect(result.rows.every((r) => r.juegoSku === "1138")).toBe(true);
    expect(result.rows[0]).toMatchObject({ sku: "1138-1", descripcion: "Base alinea y combina" });
    expect(result.rows[1]).toMatchObject({ sku: "3346-17", descripcion: "Ficha para contar chica azul" });
    expect(result.rows[2]).toMatchObject({ sku: "", descripcion: "Etiqueta base" });
  });

  it("reporta encabezados faltantes", () => {
    const sheet = XLSX.utils.aoa_to_sheet([["Origen", "SKU"], ["BOD", "1000"]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Piezas");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    const result = readPiezasWorkbook(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missingHeaders).toContain("Descripción");
    expect(result.missingHeaders).toContain("Links Imágenes Piezas");
  });

  it("si el link es un hipervínculo de Excel con texto visible distinto, usa la URL real (cell.l.Target), no el texto", () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      REAL_HEADERS,
      ["", "", "1000", "JUEGO", "", "", "", "", "", "", "", ""],
      ["", "BOD", "", "Pieza uno", "1", "", "10", "", "1.00", "", "", "Ver imagen"],
    ]);
    sheet["L3"].l = {
      Target: "https://drive.google.com/file/d/1rlAwsYbaIQC_H41aEpCB1NOtDBCsJOkG/view",
    };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Piezas");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);

    const result = readPiezasWorkbook(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].linkImagen).toBe(
      "https://drive.google.com/file/d/1rlAwsYbaIQC_H41aEpCB1NOtDBCsJOkG/view",
    );
  });
});

// --- classifyPiezaRows ---

describe("classifyPiezaRows", () => {
  it("juego resuelto, pieza nueva (sin match por nombre) -> nueva", () => {
    const row = makeRow();
    const lookups = new Map<number, PiezaRowLookup>([[row.fila, { juego: makeJuego(), pieza: null }]]);
    const [result] = classifyPiezaRows([row], lookups);
    expect(result.status).toBe("nueva");
    expect(result.matchedJuego?.codigo).toBe("7234");
  });

  it("ya existe una pieza con ese nombre en ese juego -> actualizar", () => {
    const row = makeRow();
    const pieza = makePieza();
    const lookups = new Map<number, PiezaRowLookup>([[row.fila, { juego: makeJuego(), pieza }]]);
    const [result] = classifyPiezaRows([row], lookups);
    expect(result.status).toBe("actualizar");
    expect(result.matchedPieza?.id).toBe(10);
  });

  it("mismo nombre de pieza en juegos distintos del archivo no se confunde (dos 'nueva' separadas)", () => {
    const rowA = makeRow({ fila: 2, juegoSku: "7234", descripcion: "Tubo 2\"" });
    const rowB = makeRow({ fila: 3, juegoSku: "8100", descripcion: "Tubo 2\"" });
    const juegoA = makeJuego({ id: 1, codigo: "7234" });
    const juegoB = makeJuego({ id: 2, codigo: "8100" });
    const lookups = new Map<number, PiezaRowLookup>([
      [2, { juego: juegoA, pieza: null }],
      [3, { juego: juegoB, pieza: null }],
    ]);
    const results = classifyPiezaRows([rowA, rowB], lookups);
    expect(results[0].status).toBe("nueva");
    expect(results[1].status).toBe("nueva");
  });

  it("juego inexistente (SKU del juego no resuelve a ningún producto) -> sin-relacion con el motivo fijo", () => {
    const row = makeRow();
    const lookups = new Map<number, PiezaRowLookup>([[row.fila, { juego: null, pieza: null }]]);
    const [result] = classifyPiezaRows([row], lookups);
    expect(result.status).toBe("sin-relacion");
    expect(result.reason).toBe(SIN_RELACION_MOTIVO);
  });

  it("fila sin juegoSku (apareció antes de cualquier fila de juego) -> sin-relacion con motivo específico", () => {
    const row = makeRow({ juegoSku: "" });
    const [result] = classifyPiezaRows([row], new Map());
    expect(result.status).toBe("sin-relacion");
    expect(result.reason).toBe(SIN_JUEGO_PREVIO_MOTIVO);
  });

  it("Descripción vacía -> error (se usa como nombre de la pieza)", () => {
    const row = makeRow({ descripcion: "" });
    const [result] = classifyPiezaRows([row], new Map());
    expect(result.status).toBe("error");
  });

  it("pieza repetida (mismo nombre) dentro del mismo juego en el archivo -> error en la segunda ocurrencia", () => {
    const juego = makeJuego();
    const rowA = makeRow({ fila: 2, descripcion: "Tubo 2\"" });
    const rowB = makeRow({ fila: 3, descripcion: "Tubo 2\"" });
    const lookups = new Map<number, PiezaRowLookup>([
      [2, { juego, pieza: null }],
      [3, { juego, pieza: null }],
    ]);
    const results = classifyPiezaRows([rowA, rowB], lookups);
    expect(results[0].status).toBe("nueva");
    expect(results[1].status).toBe("error");
    expect(results[1].reason).toMatch(/repetid/);
  });

  it("mismo nombre repetido entre filas 'sin-relacion' NO se marca como error (sin juego que las desambigüe)", () => {
    const rowA = makeRow({ fila: 2, juegoSku: "", descripcion: "Tubo 2\"" });
    const rowB = makeRow({ fila: 3, juegoSku: "", descripcion: "Tubo 2\"" });
    const results = classifyPiezaRows([rowA, rowB], new Map());
    expect(results[0].status).toBe("sin-relacion");
    expect(results[1].status).toBe("sin-relacion");
  });

  it("con SKU propio, el duplicado se detecta por SKU (no por nombre) dentro del mismo juego", () => {
    const juego = makeJuego();
    const rowA = makeRow({ fila: 2, sku: "1138-1", descripcion: "Base alinea y combina" });
    const rowB = makeRow({ fila: 3, sku: "1138-1", descripcion: "Nombre distinto pero mismo SKU" });
    const lookups = new Map<number, PiezaRowLookup>([
      [2, { juego, pieza: null }],
      [3, { juego, pieza: null }],
    ]);
    const results = classifyPiezaRows([rowA, rowB], lookups);
    expect(results[0].status).toBe("nueva");
    expect(results[1].status).toBe("error");
    expect(results[1].reason).toMatch(/repetid/);
  });

  it("con SKU propio, dos piezas con SKU distinto pero mismo nombre NO se marcan como duplicado", () => {
    const juego = makeJuego();
    const rowA = makeRow({ fila: 2, sku: "1138-1", descripcion: "Ficha para contar chica azul" });
    const rowB = makeRow({ fila: 3, sku: "3346-17", descripcion: "Ficha para contar chica azul" });
    const lookups = new Map<number, PiezaRowLookup>([
      [2, { juego, pieza: null }],
      [3, { juego, pieza: null }],
    ]);
    const results = classifyPiezaRows([rowA, rowB], lookups);
    expect(results[0].status).toBe("nueva");
    expect(results[1].status).toBe("nueva");
  });

  it("imageStatus: con-link / sin-link / link-invalido", () => {
    const conLink = makeRow({ linkImagen: "https://drive.google.com/file/d/ABC/view" });
    const sinLink = makeRow({ fila: 3, linkImagen: "" });
    const invalido = makeRow({ fila: 4, linkImagen: "no es una url" });
    const lookups = new Map<number, PiezaRowLookup>([
      [3, { juego: makeJuego(), pieza: null }],
      [4, { juego: makeJuego(), pieza: null }],
    ]);
    lookups.set(conLink.fila, { juego: makeJuego(), pieza: null });
    const results = classifyPiezaRows([conLink, sinLink, invalido], lookups);
    expect(results[0].imageStatus).toBe("con-link");
    expect(results[1].imageStatus).toBe("sin-link");
    expect(results[2].imageStatus).toBe("link-invalido");
  });
});

// --- buildPiezaInput ---

describe("buildPiezaInput", () => {
  it("en una actualización preserva sku/color/material/tipo_empaque existentes", () => {
    const row = makeRow();
    const pieza = makePieza({ sku: "P-001", color: "Azul", material: "PVC", tipo_empaque: "Bolsa" });
    const [classified] = classifyPiezaRows([row], new Map([[row.fila, { juego: makeJuego(), pieza }]]));
    const input = buildPiezaInput(classified, null);
    expect(input.sku).toBe("P-001");
    expect(input.color).toBe("Azul");
    expect(input.material).toBe("PVC");
    expect(input.tipo_empaque).toBe("Bolsa");
    expect(input.nombre).toBe('Tubo 2"');
    expect(input.componentes_fabricacion).toBe("6");
  });

  it("el SKU propio de la fila tiene prioridad sobre el que ya tuviera la pieza existente", () => {
    const row = makeRow({ sku: "1138-1" });
    const pieza = makePieza({ sku: "SKU-VIEJO" });
    const [classified] = classifyPiezaRows([row], new Map([[row.fila, { juego: makeJuego(), pieza }]]));
    const input = buildPiezaInput(classified, null);
    expect(input.sku).toBe("1138-1");
  });

  it("en un alta nueva, sku/color/material/tipo_empaque quedan vacíos", () => {
    const row = makeRow();
    const [classified] = classifyPiezaRows([row], new Map([[row.fila, { juego: makeJuego(), pieza: null }]]));
    const input = buildPiezaInput(classified, null);
    expect(input.sku).toBe("");
    expect(input.color).toBe("");
    expect(input.material).toBe("");
    expect(input.tipo_empaque).toBe("");
  });

  it("usa la imagen descargada cuando se provee, en vez de la existente", () => {
    const row = makeRow();
    const pieza = makePieza({ imagen: { data: new Uint8Array([9, 9]), mime: "image/png" } });
    const [classified] = classifyPiezaRows([row], new Map([[row.fila, { juego: makeJuego(), pieza }]]));
    const newImage = { data: new Uint8Array([1, 2, 3]), mime: "image/jpeg" };
    const input = buildPiezaInput(classified, newImage);
    expect(input.imagen).toEqual(newImage);
  });
});

// --- findPlasticProductInJuegoByNombre / importPiezaRow (integración contra BD) ---

describe("findPlasticProductInJuegoByNombre + importPiezaRow", () => {
  async function seedJuego(codigo: string): Promise<number> {
    const client = rawClient();
    const result = await client.execute({
      sql: "INSERT INTO products (codigo, nombre) VALUES (?1, ?2)",
      args: [codigo, `Juego ${codigo}`],
    });
    return Number(result.lastInsertRowid);
  }

  it("crea una pieza nueva y su relación con el juego", async () => {
    const actor = await createFixtureUser({ username: "u1", permisos: ["plasticos"] });
    const productId = await seedJuego("7234");

    const [classified] = classifyPiezaRows(
      [makeRow()],
      new Map([[3, { juego: makeJuego({ id: productId, codigo: "7234" }), pieza: null }]]),
    );
    const input = buildPiezaInput(classified, null);
    const plasticId = await importPiezaRow(actor, productId, null, input, 1);

    const pieza = await rawClient().execute({
      sql: "SELECT * FROM plastic_products WHERE id = ?1",
      args: [plasticId],
    });
    expect(pieza.rows).toHaveLength(1);

    const rel = await rawClient().execute({
      sql: "SELECT * FROM product_plastic_items WHERE product_id = ?1 AND plastic_product_id = ?2",
      args: [productId, plasticId],
    });
    expect(rel.rows).toHaveLength(1);
  });

  it("actualiza una pieza existente (mismo nombre en el mismo juego) sin duplicar la fila de relación", async () => {
    const actor = await createFixtureUser({ username: "u2", permisos: ["plasticos"] });
    const productId = await seedJuego("7234");

    const [classified] = classifyPiezaRows(
      [makeRow()],
      new Map([[3, { juego: makeJuego({ id: productId, codigo: "7234" }), pieza: null }]]),
    );
    const input = buildPiezaInput(classified, null);
    const plasticId = await importPiezaRow(actor, productId, null, input, 1);

    const found = await findPlasticProductInJuegoByNombre('Tubo 2"', productId);
    expect(found?.id).toBe(plasticId);

    const updatedInput = { ...input, coste: "99.00" };
    await importPiezaRow(actor, productId, plasticId, updatedInput, 1);

    const rel = await rawClient().execute({
      sql: "SELECT * FROM product_plastic_items WHERE product_id = ?1",
      args: [productId],
    });
    expect(rel.rows).toHaveLength(1);

    const pieza = await rawClient().execute({
      sql: "SELECT coste FROM plastic_products WHERE id = ?1",
      args: [plasticId],
    });
    expect((pieza.rows[0] as unknown as { coste: string }).coste).toBe("99.00");
  });

  it("findPlasticProductInJuegoByNombre no confunde el mismo nombre en otro juego", async () => {
    const actor = await createFixtureUser({ username: "u3", permisos: ["plasticos"] });
    const productA = await seedJuego("7234");
    const productB = await seedJuego("8100");

    const [classified] = classifyPiezaRows(
      [makeRow()],
      new Map([[3, { juego: makeJuego({ id: productA, codigo: "7234" }), pieza: null }]]),
    );
    const input = buildPiezaInput(classified, null);
    await importPiezaRow(actor, productA, null, input, 1);

    const foundInB = await findPlasticProductInJuegoByNombre('Tubo 2"', productB);
    expect(foundInB).toBeNull();
  });

  it("findPlasticProductInJuegoBySku encuentra por SKU propio dentro del juego, pero no en otro juego", async () => {
    const actor = await createFixtureUser({ username: "u3b", permisos: ["plasticos"] });
    const productA = await seedJuego("1138");
    const productB = await seedJuego("9999");

    const [classified] = classifyPiezaRows(
      [makeRow({ sku: "1138-1", juegoSku: "1138" })],
      new Map([[3, { juego: makeJuego({ id: productA, codigo: "1138" }), pieza: null }]]),
    );
    const input = buildPiezaInput(classified, null);
    const plasticId = await importPiezaRow(actor, productA, null, input, 1);

    const foundInA = await findPlasticProductInJuegoBySku("1138-1", productA);
    expect(foundInA?.id).toBe(plasticId);

    const foundInB = await findPlasticProductInJuegoBySku("1138-1", productB);
    expect(foundInB).toBeNull();
  });

  it("exige el permiso 'plasticos'", async () => {
    const actor = await createFixtureUser({ username: "sin-permiso", permisos: [] });
    const productId = await seedJuego("9000");
    const [classified] = classifyPiezaRows(
      [makeRow()],
      new Map([[3, { juego: makeJuego({ id: productId, codigo: "9000" }), pieza: null }]]),
    );
    const input = buildPiezaInput(classified, null);
    await expect(importPiezaRow(actor, productId, null, input, 1)).rejects.toThrow();
  });
});

// --- Piezas "sin relación" (sin juego) ---

describe("importPiezaRow con productId null (piezas sin relación a un juego)", () => {
  it("crea la pieza en el catálogo maestro sin fila en product_plastic_items", async () => {
    const actor = await createFixtureUser({ username: "u4", permisos: ["plasticos"] });
    const [classified] = classifyPiezaRows([makeRow({ juegoSku: "" })], new Map());
    const input = buildPiezaInput(classified, null);
    const plasticId = await importPiezaRow(actor, null, null, input, 0);

    const pieza = await rawClient().execute({
      sql: "SELECT * FROM plastic_products WHERE id = ?1",
      args: [plasticId],
    });
    expect(pieza.rows).toHaveLength(1);

    const rel = await rawClient().execute({
      sql: "SELECT * FROM product_plastic_items WHERE plastic_product_id = ?1",
      args: [plasticId],
    });
    expect(rel.rows).toHaveLength(0);
  });
});

// --- Lotes de importación (registrar / consultar / deshacer) ---

describe("recordPiezaImportBatch + getLastPiezaImportBatch + undoLastPiezaImportBatch", () => {
  it("no crea ningún lote si la lista de IDs viene vacía", async () => {
    const actor = await createFixtureUser({ username: "u6", permisos: ["plasticos"] });
    await recordPiezaImportBatch(actor, []);
    expect(await getLastPiezaImportBatch()).toBeNull();
  });

  it("registra un lote y lo devuelve como el último; deshacerlo borra exactamente esas piezas", async () => {
    const actor = await createFixtureUser({ username: "u7", permisos: ["plasticos"] });
    const productId = await seedJuegoStandalone("7777");

    const [classified] = classifyPiezaRows(
      [makeRow({ juegoSku: "7777" })],
      new Map([[3, { juego: makeJuego({ id: productId, codigo: "7777" }), pieza: null }]]),
    );
    const input = buildPiezaInput(classified, null);
    const idA = await importPiezaRow(actor, productId, null, input, 1);
    const idB = await importPiezaRow(actor, null, null, { ...input, descripcion: "sin relación" }, 0);

    await recordPiezaImportBatch(actor, [idA, idB]);

    const last = await getLastPiezaImportBatch();
    expect(last?.total).toBe(2);
    expect(last?.creado_por).toBe("u7");

    const { eliminadas } = await undoLastPiezaImportBatch(actor);
    expect(eliminadas).toBe(2);

    expect(await countRows("plastic_products", "id = ?1", [idA])).toBe(0);
    expect(await countRows("plastic_products", "id = ?1", [idB])).toBe(0);
    expect(await countRows("product_plastic_items", "plastic_product_id = ?1", [idA])).toBe(0);

    // El lote queda marcado como deshecho — ya no aparece como "último" ni se puede deshacer de nuevo.
    expect(await getLastPiezaImportBatch()).toBeNull();
    await expect(undoLastPiezaImportBatch(actor)).rejects.toThrow();
  });

  it("exige el permiso 'plasticos' para deshacer", async () => {
    const actor = await createFixtureUser({ username: "sin-permiso-2", permisos: [] });
    await expect(undoLastPiezaImportBatch(actor)).rejects.toThrow();
  });

  async function seedJuegoStandalone(codigo: string): Promise<number> {
    const result = await rawClient().execute({
      sql: "INSERT INTO products (codigo, nombre) VALUES (?1, ?2)",
      args: [codigo, `Juego ${codigo}`],
    });
    return Number(result.lastInsertRowid);
  }
});
