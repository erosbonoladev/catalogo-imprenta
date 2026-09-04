import { beforeEach, describe, expect, it } from "vitest";
import { createRemisionConFolio, deleteRemision, updateRemisionConRenglones } from "../src/db";
import { countRows, createFixtureUser, rawClient, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

const baseInput = {
  fecha: "2026-09-04",
  tipo: "interna" as const,
  pedido_bodegas: "JALISCO",
  subtotal: 100,
  descuento_pct: 0,
  descuento: 0,
  iva: 16,
  total: 116,
  precio_texto: "Ciento dieciséis pesos",
  usuario: "tester",
};

const renglon = { sku: "R1", producto_nombre: "Producto R1", cantidad: 1, precio_unitario: 100, importe: 100 };

async function actor(permisos: string[]) {
  return createFixtureUser({ username: `u-${Math.random().toString(36).slice(2)}`, permisos });
}

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

  it("nunca deja un folio huérfano: si un renglón falla a mitad de la lista, tampoco quedan folio/remisión ni los renglones ya insertados antes del fallo", async () => {
    const a = await actor(["remisiones_crear"]);
    // El segundo renglón viola NOT NULL (cantidad) — el primero ya se
    // habría insertado dentro de la misma transacción antes de fallar, así
    // que esto también prueba que ESE insert previo se revierte.
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
  it("reemplaza los renglones y conserva folio/fecha/usuario originales", async () => {
    const a = await actor(["remisiones_crear"]);
    const created = await createRemisionConFolio(a, "R1", baseInput, [renglon]);

    const updated = await updateRemisionConRenglones(
      a,
      created.id,
      { ...baseInput, subtotal: 200, total: 232 },
      [renglon, { ...renglon, sku: "R2", producto_nombre: "Producto R2" }],
    );

    expect(updated.folio).toBe(created.folio);
    expect(updated.usuario).toBe(created.usuario);
    expect(updated.total).toBe(232);
    expect(updated.renglones).toHaveLength(2);
    expect(await countRows("remision_renglones", "remision_id = ?1", [created.id])).toBe(2);
  });
});

describe("deleteRemision", () => {
  it("borra la remisión y sus renglones juntos", async () => {
    const a = await actor(["remisiones_crear", "remisiones_cancelar"]);
    const created = await createRemisionConFolio(a, "R1", baseInput, [renglon]);

    await deleteRemision(a, created.id, "tester");

    expect(await countRows("remisiones", "id = ?1", [created.id])).toBe(0);
    expect(await countRows("remision_renglones", "remision_id = ?1", [created.id])).toBe(0);
  });

  it("registra un evento WARNING en app_logs al borrar", async () => {
    const a = await actor(["remisiones_crear", "remisiones_cancelar"]);
    const created = await createRemisionConFolio(a, "R1", baseInput, [renglon]);

    await deleteRemision(a, created.id, "tester");

    const logs = await rawClient().execute({
      sql: "SELECT nivel, mensaje FROM app_logs WHERE mensaje LIKE ?1",
      args: [`%#${created.id}%`],
    });
    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0].nivel).toBe("WARNING");
  });
});
