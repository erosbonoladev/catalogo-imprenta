import { beforeEach, describe, expect, it } from "vitest";
import {
  computeRemisionMontos,
  createRemisionConFolio,
  deleteRemision,
  listRemisionProductosIndex,
  listRemisiones,
  updateRemisionConRenglones,
} from "../src/db";
import { countRows, createFixtureUser, rawClient, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

const baseInput = {
  fecha: "2026-09-04",
  tipo: "interna" as const,
  pedido_bodegas: "JALISCO",
  descuento_pct: 0,
};

const renglon = { sku: "R1", producto_nombre: "Producto R1", cantidad: 1, precio_unitario: 100, importe: 100 };

async function actor(permisos: string[]) {
  const username = `u-${Math.random().toString(36).slice(2)}`;
  const user = await createFixtureUser({ username, permisos });
  return { ...user, username };
}

describe("computeRemisionMontos — fórmula única compartida con RemisionForm.tsx/RemisionDetalleModal.tsx", () => {
  it("IVA se calcula sobre el subtotal (no sobre subtotal-descuento), y el total SUMA el IVA (regla de negocio documentada en WORKFLOWS.md)", () => {
    const montos = computeRemisionMontos([{ cantidad: 2, precio_unitario: 100 }], 10);
    expect(montos.subtotal).toBe(200);
    expect(montos.descuento).toBe(20); // 10% de 200
    expect(montos.iva).toBeCloseTo(32); // 16% de 200 (subtotal), no de 180
    expect(montos.total).toBeCloseTo(200 - 20 + 32); // 212 — el IVA se suma, no se resta
  });

  it("sin descuento, el IVA se suma al subtotal", () => {
    const montos = computeRemisionMontos([{ cantidad: 1, precio_unitario: 50 }], 0);
    expect(montos.subtotal).toBe(50);
    expect(montos.descuento).toBe(0);
    expect(montos.iva).toBeCloseTo(8);
    expect(montos.total).toBeCloseTo(58);
  });

  it("suma varios renglones antes de aplicar descuento/IVA sobre el subtotal combinado", () => {
    const montos = computeRemisionMontos(
      [
        { cantidad: 3, precio_unitario: 10 },
        { cantidad: 1, precio_unitario: 20 },
      ],
      0,
    );
    expect(montos.subtotal).toBe(50);
  });
});

describe("createRemisionConFolio", () => {
  it("crea folio + header + renglones atómicamente", async () => {
    const a = await actor(["remisiones_crear"]);
    const created = await createRemisionConFolio(a, "R1", baseInput, [renglon]);

    expect(created.folio).toMatch(/\S+/);
    expect(created.renglones).toHaveLength(1);
    expect(await countRows("folios", "seccion = 'remision'")).toBe(1);
    expect(await countRows("remisiones")).toBe(1);
    expect(await countRows("remision_renglones", "remision_id = ?1", [created.id])).toBe(1);
  });

  it("guarda el tipo externa y listRemisiones lo devuelve para poder filtrar el historial", async () => {
    const a = await actor(["remisiones_crear", "remisiones_acceso"]);
    await createRemisionConFolio(a, "R1", baseInput, [renglon]);
    const externa = await createRemisionConFolio(a, "R1", { ...baseInput, tipo: "externa" }, [renglon]);

    expect(externa.tipo).toBe("externa");
    const todas = await listRemisiones(a);
    expect(todas.filter((r) => r.tipo === "externa").map((r) => r.id)).toEqual([externa.id]);
    expect(todas.filter((r) => r.tipo === "interna")).toHaveLength(1);
  });

  it("las externas guardan los datos del cliente; las internas los dejan vacíos", async () => {
    const a = await actor(["remisiones_crear", "remisiones_acceso"]);
    const externa = await createRemisionConFolio(
      a,
      "Cliente Uno",
      {
        ...baseInput,
        tipo: "externa",
        pedido_bodegas: "Cliente Uno",
        cliente_rfc: " ABC010101AAA ",
        cliente_direccion: "Av. Reforma 1",
        cliente_contacto: "Juan",
        cliente_telefono: "222 111 2233",
      },
      [{ ...renglon, sku: "" }],
    );
    const interna = await createRemisionConFolio(a, "R1", baseInput, [renglon]);

    expect(externa.cliente_rfc).toBe("ABC010101AAA");
    const guardada = (await listRemisiones(a)).find((r) => r.id === externa.id);
    expect(guardada).toMatchObject({
      pedido_bodegas: "Cliente Uno",
      cliente_direccion: "Av. Reforma 1",
      cliente_contacto: "Juan",
      cliente_telefono: "222 111 2233",
    });
    expect(interna.cliente_rfc).toBe("");
    expect(interna.cliente_telefono).toBe("");
  });

  it("una externa sin datos de cliente se guarda sin tocar las columnas cliente_*", async () => {
    const a = await actor(["remisiones_crear"]);
    await rawClient().execute("ALTER TABLE remisiones DROP COLUMN cliente_rfc");
    try {
      const externa = await createRemisionConFolio(a, "Cliente Uno", { ...baseInput, tipo: "externa" }, [renglon]);
      expect(externa.tipo).toBe("externa");
      expect(externa.cliente_rfc).toBe("");
    } finally {
      await rawClient().execute("ALTER TABLE remisiones ADD COLUMN cliente_rfc TEXT");
    }
  });

  it("las externas usan folio REMEX con consecutivo propio desde 00001, sin afectar el de las internas", async () => {
    const a = await actor(["remisiones_crear"]);
    const interna = await createRemisionConFolio(a, "R1", baseInput, [renglon]);
    const ext1 = await createRemisionConFolio(a, "Cliente Uno", { ...baseInput, tipo: "externa" }, [renglon]);
    const ext2 = await createRemisionConFolio(a, "Cliente Uno", { ...baseInput, tipo: "externa" }, [renglon]);

    expect(interna.folio).toMatch(/^REM-.*-00001$/);
    expect(ext1.folio).toMatch(/^REMEX-Cliente-Uno-\d{6}-00001$/);
    expect(ext2.folio).toMatch(/-00002$/);
    expect(await countRows("folios", "seccion = 'remision_externa'")).toBe(2);
  });

  it("el folio lleva el nombre de la bodega, no el SKU del renglón — a pedido del negocio", async () => {
    const a = await actor(["remisiones_crear"]);
    const created = await createRemisionConFolio(a, baseInput.pedido_bodegas, baseInput, [renglon]);

    expect(created.folio).toContain("JALISCO");
    expect(created.folio).not.toContain(renglon.sku);
  });

  it("recalcula importe/subtotal/iva/total server-side aunque el cliente mande esos campos manipulados", async () => {
    const a = await actor(["remisiones_crear"]);
    const renglonManipulado = { ...renglon, importe: 999999 };
    const created = await createRemisionConFolio(a, "R1", baseInput, [renglonManipulado]);

    expect(created.renglones[0].importe).toBe(100);
    expect(created.subtotal).toBe(100);
    expect(created.descuento).toBe(0);
    expect(created.iva).toBeCloseTo(16);
    expect(created.total).toBeCloseTo(116);
  });

  it("deriva remisiones.usuario del Actor verificado, no de un string aparte", async () => {
    const a = await actor(["remisiones_crear"]);
    const created = await createRemisionConFolio(a, "R1", baseInput, [renglon]);
    expect(created.usuario).toBe(a.username);
  });

  it("rechaza un renglón con cantidad <= 0", async () => {
    const a = await actor(["remisiones_crear"]);
    await expect(
      createRemisionConFolio(a, "R1", baseInput, [{ ...renglon, cantidad: 0 }]),
    ).rejects.toThrow(/cantidad inválida/i);
  });

  it("rechaza un renglón con precio_unitario negativo", async () => {
    const a = await actor(["remisiones_crear"]);
    await expect(
      createRemisionConFolio(a, "R1", baseInput, [{ ...renglon, precio_unitario: -1 }]),
    ).rejects.toThrow(/precio inválido/i);
  });

  it("acepta un renglón con precio_unitario 0 (cortesía/sin costo) — no debe rechazarse como si fuera inválido", async () => {
    const a = await actor(["remisiones_crear"]);
    const created = await createRemisionConFolio(a, "R1", baseInput, [
      { ...renglon, precio_unitario: 0, importe: 0 },
    ]);

    expect(created.renglones[0].precio_unitario).toBe(0);
    expect(created.subtotal).toBe(0);
    expect(created.total).toBe(0);
  });

  it("rechaza un descuento_pct fuera de 0-100", async () => {
    const a = await actor(["remisiones_crear"]);
    await expect(
      createRemisionConFolio(a, "R1", { ...baseInput, descuento_pct: 150 }, [renglon]),
    ).rejects.toThrow(/descuento/i);
  });

  it("no deja folio huérfano: un renglón inválido rechaza antes de escribir folio/remisión/renglones", async () => {
    const a = await actor(["remisiones_crear"]);
    const renglonInvalido = { ...renglon, sku: "R2", cantidad: null as unknown as number };

    await expect(
      createRemisionConFolio(a, "R2", baseInput, [renglon, renglonInvalido]),
    ).rejects.toThrow();

    expect(await countRows("folios", "seccion = 'remision'")).toBe(0);
    expect(await countRows("remisiones")).toBe(0);
    expect(await countRows("remision_renglones")).toBe(0);
  });

  it("cada remisión consume el siguiente consecutivo de folio, nunca se reinicia", async () => {
    const a = await actor(["remisiones_crear"]);
    const first = await createRemisionConFolio(a, "R1", baseInput, [renglon]);
    const second = await createRemisionConFolio(a, "R1", baseInput, [renglon]);
    expect(first.folio).not.toBe(second.folio);
  });
});

describe("updateRemisionConRenglones", () => {
  it("reemplaza los renglones, recalcula los totales y conserva folio/fecha/usuario originales", async () => {
    const a = await actor(["remisiones_crear"]);
    const created = await createRemisionConFolio(a, "R1", baseInput, [renglon]);

    const updated = await updateRemisionConRenglones(
      a,
      created.id,
      { pedido_bodegas: "JALISCO", descuento_pct: 0 },
      [renglon, { ...renglon, sku: "R2", producto_nombre: "Producto R2" }],
    );

    expect(updated.folio).toBe(created.folio);
    expect(updated.usuario).toBe(created.usuario);
    expect(updated.subtotal).toBe(200);
    expect(updated.total).toBeCloseTo(232);
    expect(updated.renglones).toHaveLength(2);
    expect(await countRows("remision_renglones", "remision_id = ?1", [created.id])).toBe(2);
  });
});

describe("deleteRemision", () => {
  it("borra la remisión y sus renglones juntos", async () => {
    const a = await actor(["remisiones_crear", "remisiones_cancelar"]);
    const created = await createRemisionConFolio(a, "R1", baseInput, [renglon]);

    await deleteRemision(a, created.id);

    expect(await countRows("remisiones", "id = ?1", [created.id])).toBe(0);
    expect(await countRows("remision_renglones", "remision_id = ?1", [created.id])).toBe(0);
  });

  it("registra un evento WARNING en app_logs con el usuario derivado del Actor al borrar", async () => {
    const a = await actor(["remisiones_crear", "remisiones_cancelar"]);
    const created = await createRemisionConFolio(a, "R1", baseInput, [renglon]);

    await deleteRemision(a, created.id);

    const logs = await rawClient().execute({
      sql: "SELECT nivel, mensaje, usuario FROM app_logs WHERE mensaje LIKE ?1",
      args: [`%#${created.id}%`],
    });
    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0].nivel).toBe("WARNING");
    expect(logs.rows[0].usuario).toBe(a.username);
  });
});

describe("listRemisiones", () => {
  it("sin límite devuelve TODAS las remisiones (historial), la más reciente primero", async () => {
    const a = await actor(["remisiones_crear", "remisiones_acceso"]);
    for (let i = 0; i < 35; i++) await createRemisionConFolio(a, "R1", baseInput, [renglon]);

    const todas = await listRemisiones(a);
    expect(todas).toHaveLength(35);
    expect(todas[0].id).toBeGreaterThan(todas[34].id);
    expect(await listRemisiones(a, 30)).toHaveLength(30);
  });
});

describe("listRemisionProductosIndex", () => {
  it("lista SKU y nombre de los productos de cada remisión, para buscar remisiones por producto", async () => {
    const a = await actor(["remisiones_crear", "remisiones_acceso"]);
    const r1 = await createRemisionConFolio(a, "R1", baseInput, [
      renglon,
      { ...renglon, sku: "R2", producto_nombre: "Camión Rojo" },
    ]);
    const r2 = await createRemisionConFolio(a, "R3", baseInput, [{ ...renglon, sku: "R3", producto_nombre: "Muñeca" }]);

    const index = await listRemisionProductosIndex(a);
    expect(index.filter((p) => p.remision_id === r1.id).map((p) => p.sku).sort()).toEqual(["R1", "R2"]);
    expect(index.filter((p) => p.remision_id === r2.id).map((p) => p.producto_nombre)).toEqual(["Muñeca"]);
  });

  it("se invalida al crear una remisión nueva y rechaza sin remisiones_acceso", async () => {
    const a = await actor(["remisiones_crear", "remisiones_acceso"]);
    expect(await listRemisionProductosIndex(a)).toHaveLength(0);
    await createRemisionConFolio(a, "R1", baseInput, [renglon]);
    expect(await listRemisionProductosIndex(a)).toHaveLength(1);

    const sin = await actor([]);
    await expect(listRemisionProductosIndex(sin)).rejects.toThrow(/no autorizado/i);
  });
});
