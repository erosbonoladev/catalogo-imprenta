import { describe, expect, it } from "vitest";
import {
  CUTTER_GAP_MM,
  NO_CABE_MESSAGE,
  SHEET_HEIGHT_MM,
  SHEET_WIDTH_MM,
  computeSheetLayout,
  parseDimensionCm,
  parsePiezaMedidaFromTexto,
} from "../src/corteMaderaLayout";

describe("computeSheetLayout", () => {
  it("pieza cuadrada: grid normal y rotado dan el mismo resultado", () => {
    const result = computeSheetLayout({ widthMm: 300, heightMm: 300 }, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.count).toBe(32);
    expect(result.orientation).toBe("normal");
    expect(result.gapMm).toBe(CUTTER_GAP_MM);
  });

  it("pieza rectangular: combina orientaciones para superar cualquier grid puro (115 rotada + 24 normal en la franja sobrante = 139, contra 138 de un solo grid)", () => {
    const result = computeSheetLayout({ widthMm: 100, heightMm: 200 }, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.count).toBe(139);
    expect(result.orientation).toBe("combinada");
  });

  it("caso reportado por el usuario (48x33cm, referencia pplanos.com): 17 piezas, no 15", () => {
    // El grid puro más grande (3 columnas rotadas de 33cm) da solo 15. Usar
    // 2 columnas en vez de 3 dejas una franja más ancha que alcanza para 7
    // piezas más en orientación normal — verificado a mano: 2*5 (rotada) +
    // 1*7 (normal en la franja) = 10 + 7 = 17. Caso real reportado: la
    // misma combinación en pplanos.com da 17 piezas para esta medida sobre
    // una placa de 122x244cm.
    const result = computeSheetLayout({ widthMm: 480, heightMm: 330 }, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.count).toBe(17);
    expect(result.orientation).toBe("combinada");
  });

  it("pieza que solo cabe rotada (más ancha que la placa sin rotar)", () => {
    const result = computeSheetLayout({ widthMm: 1300, heightMm: 100 }, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.count).toBe(11);
    expect(result.orientation).toBe("rotada");
  });

  it("distribución híbrida aprovecha la franja sobrante y supera al grid puro", () => {
    // Grid puro (normal u rotado) da 6 piezas de 400x1000mm; la franja
    // sobrante de altura (434mm) alcanza para una pieza más rotada —
    // verificado a mano: 3 cols x 2 rows (grid) + 1 en la franja = 7.
    const result = computeSheetLayout({ widthMm: 400, heightMm: 1000 }, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.count).toBe(7);
    expect(result.orientation).toBe("combinada");
    expect(result.placed).toHaveLength(7);
    expect(result.usedAreaMm2).toBe(2_800_000);
    expect(result.wasteAreaMm2).toBe(176_800);
  });

  it("pieza más grande que la placa en ambas orientaciones no cabe", () => {
    const result = computeSheetLayout({ widthMm: 2000, heightMm: 3000 }, 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(NO_CABE_MESSAGE);
  });

  it("pieza muy pequeña produce muchas piezas sin fallar", () => {
    const result = computeSheetLayout({ widthMm: 10, heightMm: 10 }, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.count).toBeGreaterThan(17_000);
  });

  it("margen de usuario = 0 -> separación real es exactamente 3mm", () => {
    const result = computeSheetLayout({ widthMm: 300, heightMm: 300 }, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.gapMm).toBe(3);
  });

  it("margen de usuario = 2 -> separación real es exactamente 5mm (3 + 2)", () => {
    const result = computeSheetLayout({ widthMm: 300, heightMm: 300 }, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.gapMm).toBe(5);
  });

  it("margen de la cortadora es opcional: desactivado, la separación real es solo el margen del usuario", () => {
    const conCero = computeSheetLayout({ widthMm: 300, heightMm: 300 }, 0, false);
    expect(conCero.ok).toBe(true);
    if (!conCero.ok) return;
    expect(conCero.gapMm).toBe(0);

    const conMargen = computeSheetLayout({ widthMm: 300, heightMm: 300 }, 2, false);
    expect(conMargen.ok).toBe(true);
    if (!conMargen.ok) return;
    expect(conMargen.gapMm).toBe(2);
  });

  it("margen de la cortadora activado (por defecto) sigue sumando 3mm", () => {
    const result = computeSheetLayout({ widthMm: 300, heightMm: 300 }, 2, true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.gapMm).toBe(5);
  });

  it("desactivar el margen de la cortadora nunca reduce la cantidad de piezas obtenidas", () => {
    const con = computeSheetLayout({ widthMm: 300, heightMm: 300 }, 0, true);
    const sin = computeSheetLayout({ widthMm: 300, heightMm: 300 }, 0, false);
    expect(con.ok).toBe(true);
    expect(sin.ok).toBe(true);
    if (!con.ok || !sin.ok) return;
    expect(sin.count).toBeGreaterThanOrEqual(con.count);
  });

  it("margen negativo es inválido", () => {
    const result = computeSheetLayout({ widthMm: 300, heightMm: 300 }, -1);
    expect(result.ok).toBe(false);
  });

  it("dimensiones con decimales no rompen el cálculo", () => {
    const result = computeSheetLayout({ widthMm: 305, heightMm: 602 }, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.count).toBeGreaterThan(0);
  });

  it("es determinista: mismo input produce exactamente el mismo acomodo", () => {
    const piece = { widthMm: 400, heightMm: 1000 };
    const a = computeSheetLayout(piece, 0);
    const b = computeSheetLayout(piece, 0);
    expect(a).toEqual(b);
  });

  it("las dimensiones de la placa fija son 122 x 244 cm", () => {
    expect(SHEET_WIDTH_MM).toBe(1220);
    expect(SHEET_HEIGHT_MM).toBe(2440);
  });

  it("no reserva margen en los bordes de la placa (solo entre piezas)", () => {
    const result = computeSheetLayout({ widthMm: 400, heightMm: 1000 }, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.placed.some((p) => p.xMm === 0)).toBe(true);
    expect(result.placed.some((p) => p.yMm === 0)).toBe(true);
    // el margen (3 + 2 = 5mm) solo debe verse ENTRE piezas consecutivas, no
    // como offset inicial desde el borde
    const xs = [...new Set(result.placed.map((p) => p.xMm))].sort((a, b) => a - b);
    expect(xs[0]).toBe(0);
  });
});

describe("parseDimensionCm", () => {
  it("acepta punto o coma decimal", () => {
    expect(parseDimensionCm("30.5")).toBe(305);
    expect(parseDimensionCm("30,5")).toBe(305);
  });

  it("rechaza vacío, no numérico o <= 0", () => {
    expect(parseDimensionCm("")).toBeNull();
    expect(parseDimensionCm("abc")).toBeNull();
    expect(parseDimensionCm("0")).toBeNull();
    expect(parseDimensionCm("-5")).toBeNull();
  });
});

describe("parsePiezaMedidaFromTexto", () => {
  it("reconoce patrones NNxNN con separadores comunes", () => {
    expect(parsePiezaMedidaFromTexto("67x28")).toEqual({ widthMm: 670, heightMm: 280 });
    expect(parsePiezaMedidaFromTexto("67 x 28")).toEqual({ widthMm: 670, heightMm: 280 });
    expect(parsePiezaMedidaFromTexto("67×28 cm")).toEqual({ widthMm: 670, heightMm: 280 });
  });

  it("devuelve null si no hay una medida reconocible", () => {
    expect(parsePiezaMedidaFromTexto("Grande")).toBeNull();
    expect(parsePiezaMedidaFromTexto("67")).toBeNull();
    expect(parsePiezaMedidaFromTexto("")).toBeNull();
  });
});
