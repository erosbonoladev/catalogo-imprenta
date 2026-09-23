import { beforeEach, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  SIN_JUEGO_PREVIO_MOTIVO,
  SIN_RELACION_MOTIVO,
  buildImageLinkCandidates,
  buildPiezaInput,
  classifyPiezaRows,
  normalizeImageLink,
  pieceName,
  readPiezasWorkbook,
  type PiezaRowLookup,
  type RawPiezaImportRow,
} from "../src/piezasImport";
import {
  findPlasticProductGlobalByNombre,
  findPlasticProductGlobalBySku,
  findPlasticProductInJuegoByNombre,
  findPlasticProductInJuegoByOrden,
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

describe("readPiezasWorkbook: formato Desglose (export de SKU Master reimportado)", () => {
  // Encabezados reales del export (desgloseSheetRows en excelExport.ts) más
  // "SKU Principal" (se ignora, se usa "Producto (Clave)" como llave exacta)
  // y "Vínculo producto y orden" (columna agregada a mano por el usuario en
  // su depuración, no parte del export — debe ignorarse sin confundirse con
  // "Orden").
  const DESGLOSE_HEADERS = [
    "SKU Principal",
    "Producto (Clave)",
    "Producto (Nombre)",
    "Orden",
    "SKU Pieza",
    "Nombre Pieza",
    "Cantidad",
    "Descripción",
    "Material",
    "Color",
    "Origen",
    "Dimensión",
    "Peso",
    "Tipo de empaque",
    "Maquila",
    "Costo",
    "Componentes de fabricación",
    "Dimensiones de empaque",
    "Vínculo producto y orden",
  ];

  function buildDesgloseWorkbook(rows: (string | number)[][], sheetName = "Desglose"): Uint8Array {
    const wb = XLSX.utils.book_new();
    // Una hoja irrelevante primero (como "Hoja 1" en el archivo real del
    // usuario) — la detección debe ser por NOMBRE de hoja, no por posición.
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["algo"], ["irrelevante"]]), "Hoja 1");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([DESGLOSE_HEADERS, ...rows]), sheetName);
    return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
  }

  it("detecta la hoja 'Desglose' por nombre (no por posición) y lee filas planas, un juego por fila", () => {
    const bytes = buildDesgloseWorkbook([
      ["1000", "1000", "Ábaco Gigante", "1", "", "Codo 90° 2\"", "", "Codo 90° 2\"", "", "", "BOD", "", "308.4", "", "5.00", "30.84", "6", "", "1000:1"],
      ["1000", "1000", "Ábaco Gigante", "2", "1138-1", "Tee 2\"", "", "Tee 2\"", "", "", "GIL", "", "237.6", "", "5.00", "23.76", "3", "", "1000:2"],
    ]);
    const result = readPiezasWorkbook(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ juegoSku: "1000", sku: "", nombre: 'Codo 90° 2"', orden: 1 });
    expect(result.rows[1]).toMatchObject({ juegoSku: "1000", sku: "1138-1", nombre: 'Tee 2"', orden: 2 });
  });

  it("no confunde la columna 'Orden' con 'Vínculo producto y orden' (ambas contienen el token 'orden')", () => {
    const bytes = buildDesgloseWorkbook([
      ["1000", "1000", "Ábaco Gigante", "7", "", "Pieza", "", "Pieza", "", "", "BOD", "", "10", "", "1.00", "1.00", "1", "", "1000:7"],
    ]);
    const result = readPiezasWorkbook(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].orden).toBe(7);
  });

  it("cuando 'Descripción' viene vacía, usa 'Nombre Pieza' tanto para nombre como para descripcion", () => {
    const bytes = buildDesgloseWorkbook([
      ["1029", "1029", "Teatro Digital", "1", "", "Tela Teatro Digital", "", "", "", "", "EXTR", "", "247.2", "", "", "", "", "", "1029:1"],
    ]);
    const result = readPiezasWorkbook(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].nombre).toBe("Tela Teatro Digital");
    expect(result.rows[0].descripcion).toBe("Tela Teatro Digital");
  });

  it("lee Material/Color/Tipo de empaque cuando la fila los trae", () => {
    const bytes = buildDesgloseWorkbook([
      ["1129", "1129", "Caja Mis Primeras Matemáticas", "1", "3075-1T", "No. Didáctico 1 Azul", "", "", "Plastico", "Azul", "BOD", "3.8x3.5x1", "0.004", "Madera", "", "", "", "", "1129:1"],
    ]);
    const result = readPiezasWorkbook(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]).toMatchObject({ material: "Plastico", color: "Azul", tipoEmpaque: "Madera" });
  });

  it("fila sin 'Producto (Clave)' (marcador de pieza sin relación, ej. 'SIN-PRODUCTO') queda con juegoSku vacío", () => {
    const bytes = buildDesgloseWorkbook([
      ["", "", "", "", "", "Cubo", "", "", "Plástico", "Rojo", "BOD", "", "", "", "", "", "", "", "SIN-PRODUCTO:2669"],
    ]);
    const result = readPiezasWorkbook(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].juegoSku).toBe("");
    expect(result.rows[0].nombre).toBe("Cubo");
  });

  it("reporta encabezados faltantes específicos del formato Desglose (no los del formato clásico)", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([["Producto (Clave)", "Nombre Pieza"], ["1000", "Pieza"]]),
      "Desglose",
    );
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    const result = readPiezasWorkbook(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missingHeaders).toContain("SKU Pieza");
    expect(result.missingHeaders).toContain("Orden");
    expect(result.missingHeaders).not.toContain("Links Imágenes Piezas");
  });

  it("sin ninguna hoja 'Desglose', cae al formato clásico (primera hoja, agrupado por bloques)", () => {
    const REAL_HEADERS = [
      "IMAGEN", "ORIGEN", "SKU", "Descripción", "COMPONENTES DE FABRICACION",
      "Dimensiones", "PESO (GR.)", "MAQUILA", "COSTO", "NETO PROD",
      "DIMENSIONES EMPAQUE", "LINKS IMAGENES PIEZAS",
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        REAL_HEADERS,
        ["", "", "1042", "PORTA LIBROS", "17", "", "3410", "", "477.80", "", "", ""],
        ["", "BOD", "", "Tela porta libro", "1", "", "955", "", "220.00", "", "", ""],
      ]),
      "Piezas",
    );
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    const result = readPiezasWorkbook(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ juegoSku: "1042", descripcion: "Tela porta libro" });
    expect(result.rows[0].orden).toBeUndefined();
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
    expect(result.matchedDuplicado).toBeUndefined();
  });

  it("nueva con coincidencia global (otro juego, o sin ninguno) -> arrastra matchedDuplicado sin cambiar el status", () => {
    const row = makeRow();
    const duplicado = makePieza({ id: 99, nombre: "Tubo 2\"" });
    const lookups = new Map<number, PiezaRowLookup>([
      [
        row.fila,
        {
          juego: makeJuego(),
          pieza: null,
          globalDuplicado: { pieza: duplicado, matchedBy: "nombre", usadaEn: [{ id: 5, codigo: "8100", nombre: "Otro juego" }] },
        },
      ],
    ]);
    const [result] = classifyPiezaRows([row], lookups);
    expect(result.status).toBe("nueva");
    expect(result.matchedDuplicado?.pieza.id).toBe(99);
    expect(result.matchedDuplicado?.matchedBy).toBe("nombre");
    expect(result.matchedDuplicado?.usadaEn).toEqual([{ id: 5, codigo: "8100", nombre: "Otro juego" }]);
  });

  it("actualizar (ya matcheó dentro del juego) no lleva matchedDuplicado aunque el lookup lo traiga", () => {
    const row = makeRow();
    const pieza = makePieza();
    const duplicado = makePieza({ id: 99 });
    const lookups = new Map<number, PiezaRowLookup>([
      [row.fila, { juego: makeJuego(), pieza, globalDuplicado: { pieza: duplicado, matchedBy: "sku", usadaEn: [] } }],
    ]);
    const [result] = classifyPiezaRows([row], lookups);
    expect(result.status).toBe("actualizar");
    expect(result.matchedDuplicado).toBeUndefined();
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

  it("formato Desglose: usa 'nombre' (Nombre Pieza) en vez de 'descripcion' para validar y para el dedup por nombre", () => {
    const rowA = makeRow({ fila: 2, descripcion: "", nombre: "Tela Teatro Digital" });
    const rowB = makeRow({ fila: 3, descripcion: "otra descripcion", nombre: "Tela Teatro Digital" });
    const juego = makeJuego();
    const lookups = new Map<number, PiezaRowLookup>([
      [2, { juego, pieza: null }],
      [3, { juego, pieza: null }],
    ]);
    const results = classifyPiezaRows([rowA, rowB], lookups);
    // La primera no es error aunque "descripcion" venga vacía (usa "nombre").
    expect(results[0].status).toBe("nueva");
    // La segunda es duplicado del mismo juego por "nombre" (Nombre Pieza),
    // aunque su "descripcion" sea distinta.
    expect(results[1].status).toBe("error");
    expect(results[1].reason).toMatch(/repetid/);
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

  it("formato Desglose: nombre usa 'Nombre Pieza' con prioridad sobre 'Descripción' cuando difieren", () => {
    const row = makeRow({ nombre: "No. Didáctico 1 Azul", descripcion: "otra cosa" });
    const [classified] = classifyPiezaRows([row], new Map([[row.fila, { juego: makeJuego(), pieza: null }]]));
    const input = buildPiezaInput(classified, null);
    expect(input.nombre).toBe("No. Didáctico 1 Azul");
  });

  it("formato Desglose: Material/Color/Tipo de empaque presentes en la fila reemplazan lo existente", () => {
    const row = makeRow({ material: "Plastico", color: "Azul", tipoEmpaque: "Madera" });
    const pieza = makePieza({ material: "ABS", color: "Rojo", tipo_empaque: "Caja" });
    const [classified] = classifyPiezaRows([row], new Map([[row.fila, { juego: makeJuego(), pieza }]]));
    const input = buildPiezaInput(classified, null);
    expect(input.material).toBe("Plastico");
    expect(input.color).toBe("Azul");
    expect(input.tipo_empaque).toBe("Madera");
  });

  it("formato Desglose: Material/Color/Tipo de empaque vacíos (string vacío, no undefined) conservan lo existente", () => {
    const row = makeRow({ material: "", color: "", tipoEmpaque: "" });
    const pieza = makePieza({ material: "ABS", color: "Rojo", tipo_empaque: "Caja" });
    const [classified] = classifyPiezaRows([row], new Map([[row.fila, { juego: makeJuego(), pieza }]]));
    const input = buildPiezaInput(classified, null);
    expect(input.material).toBe("ABS");
    expect(input.color).toBe("Rojo");
    expect(input.tipo_empaque).toBe("Caja");
  });
});

describe("pieceName", () => {
  it("usa 'nombre' cuando está presente, cae a 'descripcion' cuando no", () => {
    expect(pieceName(makeRow({ nombre: "Nombre Pieza", descripcion: "Otra" }))).toBe("Nombre Pieza");
    expect(pieceName(makeRow({ nombre: undefined, descripcion: "Solo descripcion" }))).toBe("Solo descripcion");
    expect(pieceName(makeRow({ nombre: "", descripcion: "Solo descripcion" }))).toBe("Solo descripcion");
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

  it("findPlasticProductInJuegoByOrden encuentra por posición dentro del juego, pero no en otro juego ni en otra posición", async () => {
    const actor = await createFixtureUser({ username: "u3c", permisos: ["plasticos"] });
    const productA = await seedJuego("1000");
    const productB = await seedJuego("9999");

    const [classified] = classifyPiezaRows(
      [makeRow({ juegoSku: "1000", orden: 7 })],
      new Map([[3, { juego: makeJuego({ id: productA, codigo: "1000" }), pieza: null }]]),
    );
    const input = buildPiezaInput(classified, null);
    const plasticId = await importPiezaRow(actor, productA, null, input, 7);

    const foundInA = await findPlasticProductInJuegoByOrden(productA, 7);
    expect(foundInA?.id).toBe(plasticId);

    expect(await findPlasticProductInJuegoByOrden(productA, 8)).toBeNull();
    expect(await findPlasticProductInJuegoByOrden(productB, 7)).toBeNull();
  });

  it("reencuentra una pieza cuyo SKU cambió (depuración externa) por posición, y el SKU nuevo de la fila gana al actualizar", async () => {
    const actor = await createFixtureUser({ username: "u3d", permisos: ["plasticos"] });
    const productId = await seedJuego("4011");

    const original = classifyPiezaRows(
      [makeRow({ juegoSku: "4011", sku: "4011-1", orden: 1, descripcion: "Ladrillo grande amarillo" })],
      new Map([[3, { juego: makeJuego({ id: productId, codigo: "4011" }), pieza: null }]]),
    )[0];
    const plasticId = await importPiezaRow(actor, productId, null, buildPiezaInput(original, null), 1);

    // El SKU de la fila cambió (ej. "Cambios aplicados": 4011-1 -> 2046-1),
    // así que ya no matchea por SKU — pero sí por posición (orden 1).
    const pieza = await findPlasticProductInJuegoByOrden(productId, 1);
    expect(pieza?.id).toBe(plasticId);

    const corregida = classifyPiezaRows(
      [makeRow({ juegoSku: "4011", sku: "2046-1", orden: 1, descripcion: "Ladrillo grande amarillo" })],
      new Map([[3, { juego: makeJuego({ id: productId, codigo: "4011" }), pieza }]]),
    )[0];
    await importPiezaRow(actor, productId, plasticId, buildPiezaInput(corregida, null), 1);

    const actualizado = await rawClient().execute({
      sql: "SELECT sku FROM plastic_products WHERE id = ?1",
      args: [plasticId],
    });
    expect((actualizado.rows[0] as unknown as { sku: string }).sku).toBe("2046-1");
  });

  it("findPlasticProductGlobalBySku encuentra una pieza sin importar a qué juego está ligada (o si no tiene ninguno)", async () => {
    const actor = await createFixtureUser({ username: "u3e", permisos: ["plasticos"] });
    const productA = await seedJuego("1000");

    const [classified] = classifyPiezaRows(
      [makeRow({ juegoSku: "1000", sku: "3346-17", orden: 1 })],
      new Map([[3, { juego: makeJuego({ id: productA, codigo: "1000" }), pieza: null }]]),
    );
    const plasticId = await importPiezaRow(actor, productA, null, buildPiezaInput(classified, null), 1);

    const found = await findPlasticProductGlobalBySku("3346-17");
    expect(found?.id).toBe(plasticId);
    expect(await findPlasticProductGlobalBySku("no-existe")).toBeNull();
  });

  it("findPlasticProductGlobalByNombre encuentra por nombre exacto (sin distinguir mayúsculas/espacios) en cualquier juego", async () => {
    const actor = await createFixtureUser({ username: "u3f", permisos: ["plasticos"] });
    const productA = await seedJuego("7234");

    const [classified] = classifyPiezaRows(
      [makeRow({ juegoSku: "7234", descripcion: 'Tubo 2"' })],
      new Map([[3, { juego: makeJuego({ id: productA, codigo: "7234" }), pieza: null }]]),
    );
    const plasticId = await importPiezaRow(actor, productA, null, buildPiezaInput(classified, null), 1);

    const found = await findPlasticProductGlobalByNombre('  tubo 2"  ');
    expect(found?.id).toBe(plasticId);
    expect(await findPlasticProductGlobalByNombre("pieza que no existe")).toBeNull();
  });

  it("importPiezaRow con un plasticProductId de OTRO juego: liga la pieza existente a este juego sin duplicar ni tocar su vínculo anterior", async () => {
    const actor = await createFixtureUser({ username: "u3g", permisos: ["plasticos"] });
    const productA = await seedJuego("1000");
    const productB = await seedJuego("1001");

    const [classifiedA] = classifyPiezaRows(
      [makeRow({ juegoSku: "1000", descripcion: 'Tubo 2"' })],
      new Map([[3, { juego: makeJuego({ id: productA, codigo: "1000" }), pieza: null }]]),
    );
    const plasticId = await importPiezaRow(actor, productA, null, buildPiezaInput(classifiedA, null), 1);

    // La fila del juego B "vincula a la pieza existente" en vez de crear una nueva.
    const [classifiedB] = classifyPiezaRows(
      [makeRow({ juegoSku: "1001", descripcion: 'Tubo 2"', coste: "99.00" })],
      new Map([[3, { juego: makeJuego({ id: productB, codigo: "1001" }), pieza: null }]]),
    );
    const linkedId = await importPiezaRow(actor, productB, plasticId, buildPiezaInput(classifiedB, null), 1);
    expect(linkedId).toBe(plasticId);

    const relA = await rawClient().execute({
      sql: "SELECT * FROM product_plastic_items WHERE product_id = ?1 AND plastic_product_id = ?2",
      args: [productA, plasticId],
    });
    expect(relA.rows).toHaveLength(1); // el vínculo original con el juego A sigue intacto

    const relB = await rawClient().execute({
      sql: "SELECT * FROM product_plastic_items WHERE product_id = ?1 AND plastic_product_id = ?2",
      args: [productB, plasticId],
    });
    expect(relB.rows).toHaveLength(1); // se creó el nuevo vínculo con el juego B

    const pieza = await rawClient().execute({
      sql: "SELECT coste FROM plastic_products WHERE id = ?1",
      args: [plasticId],
    });
    expect((pieza.rows[0] as unknown as { coste: string }).coste).toBe("99.00"); // se actualizó con la fila del juego B

    // Llamarlo de nuevo con el mismo juego B no duplica el vínculo.
    await importPiezaRow(actor, productB, plasticId, buildPiezaInput(classifiedB, null), 1);
    const relBOtraVez = await rawClient().execute({
      sql: "SELECT * FROM product_plastic_items WHERE product_id = ?1 AND plastic_product_id = ?2",
      args: [productB, plasticId],
    });
    expect(relBOtraVez.rows).toHaveLength(1);
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
