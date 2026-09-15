import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  EXPECTED_HEADERS,
  classifyCorreccionRows,
  readWorkbook,
  type RawCorreccionRow,
} from "../src/correccionImport";
import type { Product } from "../src/types";

function makeRow(overrides: Partial<RawCorreccionRow> = {}): RawCorreccionRow {
  return {
    fila: 2,
    sku: "1138",
    producto: "Rompecabezas de madera",
    categoria: "Rompecabezas",
    tipoProducto: "Rompecabezas y resaques",
    codigoBarras: "7501234567890",
    gobiernoRaw: "100",
    representanteRaw: "90",
    mayoreoRaw: "80",
    medioMayoreoRaw: "85",
    publicoSugeridoRaw: "120",
    ...overrides,
  };
}

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 1,
    codigo: "1138",
    nombre: "Rompecabezas de madera",
    categoria: "Juguetes",
    material: "Madera",
    descripcion: "Descripción de catálogo",
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

function classifyOne(rowOverrides: Partial<RawCorreccionRow>, product: Product | null) {
  const row = makeRow(rowOverrides);
  const result = classifyCorreccionRows([row], new Map([[row.fila, product]]));
  return result[0];
}

// --- readWorkbook ---

describe("readWorkbook", () => {
  function buildXlsx(headers: string[], rows: (string | number)[][]): Uint8Array {
    const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
    return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
  }

  it("lee una fila real con las 10 columnas esperadas", () => {
    const bytes = buildXlsx(EXPECTED_HEADERS.slice(), [
      ["1138", "Rompecabezas de madera", "Rompecabezas", "Rompecabezas y resaques", "7501234567890", 100, 90, 80, 85, 120],
    ]);
    const result = readWorkbook(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      fila: 2,
      sku: "1138",
      producto: "Rompecabezas de madera",
      categoria: "Rompecabezas",
      tipoProducto: "Rompecabezas y resaques",
      codigoBarras: "7501234567890",
      gobiernoRaw: 100,
      representanteRaw: 90,
      mayoreoRaw: 80,
      medioMayoreoRaw: 85,
      publicoSugeridoRaw: 120,
    });
  });

  it("encabezados sin acentos/case distinto igual calzan (normalización NFD)", () => {
    const bytes = buildXlsx(
      ["sku", "PRODUCTO", "categoria", "TIPO DE PRODUCTO", "codigo de barras", "gobierno", "representante", "mayoreo", "medio mayoreo", "publico sugerido"],
      [["1138", "Rompecabezas de madera", "Rompecabezas", "", "", "", "", "", "", ""]],
    );
    const result = readWorkbook(bytes);
    expect(result.ok).toBe(true);
  });

  it("archivo sin las columnas esperadas -> ok:false listando lo que falta", () => {
    const bytes = buildXlsx(["SKU", "Producto"], [["1138", "Rompecabezas"]]);
    const result = readWorkbook(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missingHeaders).toContain("Categoría");
    expect(result.missingHeaders).toContain("Gobierno");
  });

  it("filas completamente vacías se ignoran", () => {
    const bytes = buildXlsx(EXPECTED_HEADERS.slice(), [
      ["1138", "Rompecabezas de madera", "Rompecabezas", "", "", "", "", "", "", ""],
      ["", "", "", "", "", "", "", "", "", ""],
    ]);
    const result = readWorkbook(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
  });
});

// --- classifyCorreccionRows ---

describe("classifyCorreccionRows — campos obligatorios", () => {
  it("falta SKU -> error", () => {
    const row = classifyOne({ sku: "" }, makeProduct());
    expect(row.status).toBe("error");
    expect(row.reason).toMatch(/Falta el SKU/);
  });

  it("falta Producto -> error", () => {
    const row = classifyOne({ producto: "" }, makeProduct());
    expect(row.status).toBe("error");
    expect(row.reason).toMatch(/Falta el nombre del producto/);
  });

  it("falta Categoría -> error", () => {
    const row = classifyOne({ categoria: "" }, makeProduct());
    expect(row.status).toBe("error");
    expect(row.reason).toMatch(/Falta la categoría/);
  });

  it("un campo excesivamente largo -> error, no se acorta silenciosamente", () => {
    const row = classifyOne({ sku: "x".repeat(501) }, makeProduct());
    expect(row.status).toBe("error");
    expect(row.reason).toMatch(/SKU.*excede/);
  });
});

describe("classifyCorreccionRows — SKU no encontrado", () => {
  it("no crea fichas nuevas: SKU sin ficha existente -> no_encontrado, se omite", () => {
    const row = classifyOne({}, null);
    expect(row.status).toBe("no_encontrado");
    expect(row.matchedProduct).toBeUndefined();
  });
});

describe("classifyCorreccionRows — Tipo de producto (lista cerrada)", () => {
  it("celda vacía -> no toca el valor existente (undefined, no error)", () => {
    const row = classifyOne({ tipoProducto: "" }, makeProduct());
    expect(row.status).toBe("valida");
    expect(row.tipoProductoNuevo).toBeUndefined();
  });

  it("coincide sin distinguir acentos/mayúsculas con la lista TIPOS_PRODUCTO", () => {
    const row = classifyOne({ tipoProducto: "abacos" }, makeProduct());
    expect(row.status).toBe("valida");
    expect(row.tipoProductoNuevo).toBe("Ábacos");
  });

  it("valor que no está en la lista -> error", () => {
    const row = classifyOne({ tipoProducto: "Categoría inventada" }, makeProduct());
    expect(row.status).toBe("error");
    expect(row.reason).toMatch(/Tipo de producto no reconocido/);
  });
});

describe("classifyCorreccionRows — Precios Venta (Gobierno/Representante/Mayoreo/Medio mayoreo/Publico sugerido)", () => {
  it("celda vacía -> no se incluye esa categoría (no se pisa el precio existente)", () => {
    const row = classifyOne({ gobiernoRaw: "", representanteRaw: "" }, makeProduct());
    expect(row.status).toBe("valida");
    expect(row.preciosVenta).not.toHaveProperty("Gobierno");
    expect(row.preciosVenta).not.toHaveProperty("Representante");
    expect(row.preciosVenta?.Mayoreo).toBe(80);
  });

  it("acepta formato moneda ($1,200.00) y cero", () => {
    const row = classifyOne({ gobiernoRaw: "$1,200.00", representanteRaw: 0 }, makeProduct());
    expect(row.status).toBe("valida");
    expect(row.preciosVenta?.Gobierno).toBe(1200);
    expect(row.preciosVenta?.Representante).toBe(0);
  });

  it("rechaza un precio negativo", () => {
    const row = classifyOne({ gobiernoRaw: "-5" }, makeProduct());
    expect(row.status).toBe("error");
    expect(row.reason).toMatch(/Precio inválido en: Gobierno/);
  });

  it("rechaza texto no numérico", () => {
    const row = classifyOne({ mayoreoRaw: "no aplica" }, makeProduct());
    expect(row.status).toBe("error");
    expect(row.reason).toMatch(/Precio inválido en: Mayoreo/);
  });
});

describe("classifyCorreccionRows — Código de barras", () => {
  it("celda vacía -> no toca el valor existente", () => {
    const row = classifyOne({ codigoBarras: "" }, makeProduct());
    expect(row.status).toBe("valida");
    expect(row.codigoBarrasNuevo).toBeUndefined();
  });

  it("celda con valor -> se toma tal cual (texto, no numérico)", () => {
    const row = classifyOne({ codigoBarras: "0007501234567890" }, makeProduct());
    expect(row.status).toBe("valida");
    expect(row.codigoBarrasNuevo).toBe("0007501234567890");
  });
});

describe("classifyCorreccionRows — cambio de nombre", () => {
  it("nombre distinto al de la ficha existente -> se marca para verificación, no bloquea", () => {
    const producto = makeProduct({ nombre: "Nombre viejo" });
    const row = classifyOne({ producto: "Nombre nuevo" }, producto);
    expect(row.status).toBe("valida");
    expect(row.nombreCambia).toBe(true);
    expect(row.reason).toMatch(/El nombre cambiará: "Nombre viejo" → "Nombre nuevo"/);
  });

  it("mismo nombre -> no se marca cambio", () => {
    const producto = makeProduct({ nombre: "Rompecabezas de madera" });
    const row = classifyOne({ producto: "Rompecabezas de madera" }, producto);
    expect(row.nombreCambia).toBe(false);
    expect(row.reason).toBeUndefined();
  });
});

describe("classifyCorreccionRows — SKU repetido dentro del archivo", () => {
  it("marca error en la segunda aparición, conservando la primera", () => {
    const producto = makeProduct();
    const rowA = makeRow({ fila: 2, sku: "REPE" });
    const rowB = makeRow({ fila: 5, sku: "repe" });
    const result = classifyCorreccionRows(
      [rowA, rowB],
      new Map([
        [2, producto],
        [5, producto],
      ]),
    );
    expect(result[0].status).toBe("valida");
    expect(result[1].status).toBe("error");
    expect(result[1].reason).toMatch(/ya aparece en la fila 2/);
  });
});
