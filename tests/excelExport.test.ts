import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { buildSkuMasterWorkbook, formatMoney, recetasSheetRows } from "../src/excelExport";
import type { PiezaDesgloseExportRow } from "../src/db";
import type { Precio } from "../src/types";

function pieza(overrides: Partial<PiezaDesgloseExportRow> = {}): PiezaDesgloseExportRow {
  return {
    producto_codigo: "2035",
    producto_nombre: "Juego del Granjero",
    orden: 1,
    pieza_id: 1,
    sku: "2035-1",
    nombre: "Caballo",
    descripcion: "Caballo",
    material: "",
    color: "",
    origen: "",
    dimension: "",
    peso: "0.02",
    tipo_empaque: "",
    maquila: "",
    coste: "3.20",
    componentes_fabricacion: "5",
    dimensiones_empaque: "",
    ...overrides,
  };
}

function precio(overrides: Partial<Precio> = {}): Precio {
  return {
    id: 1,
    sku: "2035",
    sku_principal: "2035",
    nombre: "Juego del Granjero",
    precio: 146.4,
    actualizado_en: "",
    actualizado_por: null,
    creado_en: "",
    tipo: null,
    ...overrides,
  };
}

// Índices de columna, mismo orden que el encabezado real de recetasSheetRows.
const COL = {
  skuPrincipal: 0,
  sku: 1,
  descripcion: 2,
  componentes: 3,
  dimensiones: 4,
  pesoPieza: 5,
  costoPieza: 6,
  pesoJuego: 7,
  costoJuego: 8,
  juegosPorEmpaque: 9,
  pesoEmpaque: 10,
  volumenEmpaque: 11,
  precioPieza: 12,
  precioJuego: 13,
  costoPorKg: 14,
  factorPrecio: 15,
  origen: 16,
  maquila: 17,
  dimensionesEmpaque: 18,
  linkImagenes: 19,
};

describe("recetasSheetRows", () => {
  it("una fila de juego (resumen, suma de sus piezas) seguida de sus piezas", () => {
    const rows = recetasSheetRows(
      [
        pieza({ sku: "2035-1", nombre: "Caballo", peso: "0.02", coste: "3.20", componentes_fabricacion: "5" }),
        pieza({ sku: "2035-2", nombre: "Jinete", peso: "0.03", coste: "4.80", componentes_fabricacion: "5" }),
      ],
      [],
    );

    // header + 1 fila de juego + 2 piezas
    expect(rows).toHaveLength(4);
    const [header, juego, pieza1, pieza2] = rows;
    expect(header[COL.sku]).toBe("SKU");

    expect(juego[COL.skuPrincipal]).toBe("2035");
    expect(juego[COL.sku]).toBe("2035");
    expect(juego[COL.descripcion]).toBe("Juego del Granjero");
    expect(juego[COL.componentes]).toBe(10); // 5 + 5
    expect(juego[COL.pesoJuego]).toBe(0.25); // 0.02*5 + 0.03*5 = 0.1 + 0.15
    expect(juego[COL.costoJuego]).toBe(formatMoney(16 + 24)); // 3.2*5 + 4.8*5

    expect(pieza1[COL.skuPrincipal]).toBe("2035"); // hereda el SKU Principal del juego, no el propio
    expect(pieza1[COL.sku]).toBe("2035-1");
    expect(pieza1[COL.pesoPieza]).toBe(0.02);
    expect(pieza1[COL.costoPieza]).toBe(formatMoney(3.2));
    expect(pieza1[COL.pesoJuego]).toBe(0.1); // 0.02 * 5
    expect(pieza1[COL.costoJuego]).toBe(formatMoney(16)); // 3.2 * 5

    expect(pieza2[COL.pesoJuego]).toBe(0.15);
  });

  it("una pieza con peso/costo no numérico no aporta a la suma del juego, pero no rompe las demás filas", () => {
    const rows = recetasSheetRows(
      [
        pieza({ sku: "2035-1", peso: "0.02", coste: "3.20", componentes_fabricacion: "5" }),
        pieza({ sku: "2035-2", nombre: "Instructivo", peso: "N/D", coste: "", componentes_fabricacion: "1" }),
      ],
      [],
    );
    const [, juego, , piezaMala] = rows;

    // Solo la pieza con datos numéricos aporta al total.
    expect(juego[COL.pesoJuego]).toBe(0.1);
    expect(juego[COL.costoJuego]).toBe(formatMoney(16));
    // Componentes sí es parseable en ambas (5 y 1) — el total no se ve afectado por el peso/costo inválidos.
    expect(juego[COL.componentes]).toBe(6);

    expect(piezaMala[COL.pesoPieza]).toBe("");
    expect(piezaMala[COL.costoPieza]).toBe("");
    expect(piezaMala[COL.pesoJuego]).toBe("");
    expect(piezaMala[COL.costoJuego]).toBe("");
  });

  it("Precio por pieza/juego buscan el SKU exacto de esa fila en `precios` — no se suman ni se mezclan", () => {
    const rows = recetasSheetRows(
      [pieza({ sku: "2035-1", peso: "0.02", coste: "3.20", componentes_fabricacion: "5" })],
      [precio({ sku: "2035", precio: 146.4 }), precio({ id: 2, sku: "2035-1", precio: 3.84 })],
    );
    const [, juego, pieza1] = rows;

    expect(juego[COL.precioJuego]).toBe(formatMoney(146.4));
    expect(juego[COL.precioPieza]).toBe(""); // el juego no tiene "precio por pieza"
    expect(pieza1[COL.precioPieza]).toBe(formatMoney(3.84));
    expect(pieza1[COL.precioJuego]).toBe(""); // la pieza no tiene "precio por juego"
  });

  it("sin precio para ese SKU, la celda de precio queda vacía (no inventa un valor)", () => {
    const rows = recetasSheetRows([pieza({ sku: "2035-1", componentes_fabricacion: "5" })], []);
    const [, juego, pieza1] = rows;
    expect(juego[COL.precioJuego]).toBe("");
    expect(pieza1[COL.precioPieza]).toBe("");
    expect(juego[COL.factorPrecio]).toBe(""); // sin precio, no hay razón que calcular
  });

  it("Factor precio = Precio del juego ÷ Costo del juego, redondeado a 2 decimales", () => {
    const rows = recetasSheetRows(
      [pieza({ sku: "2035-1", peso: "0.02", coste: "3.20", componentes_fabricacion: "5" })], // costo por juego = 16
      [precio({ sku: "2035", precio: 19.2 })], // factor = 19.2 / 16 = 1.2
    );
    const [, juego] = rows;
    expect(juego[COL.factorPrecio]).toBe("1.20");
  });

  it("columnas sin ninguna fuente de datos (Juegos por empaque, Peso/Volumen empaque, Costo por Kg, Link imágenes) quedan vacías, con su encabezado", () => {
    const rows = recetasSheetRows([pieza()], []);
    const [header, juego, pieza1] = rows;
    expect(header[COL.juegosPorEmpaque]).toBe("Juegos por empaque");
    expect(header[COL.pesoEmpaque]).toBe("Peso empaque (Kg)");
    expect(header[COL.volumenEmpaque]).toBe("Volumen empaque (M3)");
    expect(header[COL.costoPorKg]).toBe("Costo por Kg");
    expect(header[COL.linkImagenes]).toBe("Link imágenes piezas");
    for (const row of [juego, pieza1]) {
      expect(row[COL.juegosPorEmpaque]).toBe("");
      expect(row[COL.pesoEmpaque]).toBe("");
      expect(row[COL.volumenEmpaque]).toBe("");
      expect(row[COL.costoPorKg]).toBe("");
      expect(row[COL.linkImagenes]).toBe("");
    }
  });

  it("una pieza sin juego (producto_codigo null) no tiene receta que mostrar — se excluye", () => {
    const rows = recetasSheetRows(
      [pieza({ producto_codigo: null, producto_nombre: null, sku: "8080", nombre: "Pieza suelta" })],
      [],
    );
    expect(rows).toHaveLength(1); // solo el encabezado
  });

  it("Origen/Maquila/Dimensiones de empaque son propios de cada pieza, vacíos en la fila del juego", () => {
    const rows = recetasSheetRows(
      [pieza({ origen: "BOD", maquila: "5.00", dimensiones_empaque: "10x10" })],
      [],
    );
    const [, juego, pieza1] = rows;
    expect(juego[COL.origen]).toBe("");
    expect(juego[COL.maquila]).toBe("");
    expect(juego[COL.dimensionesEmpaque]).toBe("");
    expect(pieza1[COL.origen]).toBe("BOD");
    expect(pieza1[COL.maquila]).toBe("5.00");
    expect(pieza1[COL.dimensionesEmpaque]).toBe("10x10");
  });
});

describe("buildSkuMasterWorkbook", () => {
  it("incluye una hoja 'Recetas' junto a las demás", () => {
    const bytes = buildSkuMasterWorkbook({
      productos: [],
      piezas: [pieza()],
      precios: [],
      remisiones: [],
    });
    const wb = XLSX.read(bytes, { type: "array" });
    expect(wb.SheetNames).toContain("Recetas");
    expect(wb.SheetNames).toEqual(["Productos", "Desglose", "Recetas", "Precios Imprenta", "Remisiones"]);
  });
});
