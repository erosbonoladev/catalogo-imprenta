import { beforeEach, describe, expect, it } from "vitest";
import { computeRemisionMontos, createRemisionConFolio, deleteRemision, updateRemisionConRenglones } from "../src/db";
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
