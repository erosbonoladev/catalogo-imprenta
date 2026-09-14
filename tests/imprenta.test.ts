import { beforeEach, describe, expect, it } from "vitest";
import {
  createPrintItemPurchasesBatch,
  getPrintItems,
  savePrintItems,
  updatePrintItemOrder,
  updatePrintItemPurchase,
} from "../src/db";
import type { PrintItem } from "../src/types";
import { countRows, createFixtureUser, rawClient, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

async function actor(permisos: string[] = ["imprenta"]) {
  const username = `u-${Math.random().toString(36).slice(2)}`;
  const user = await createFixtureUser({ username, permisos });
  return { ...user, username };
}

async function seedProduct(codigo: string): Promise<number> {
  const result = await rawClient().execute({
    sql: "INSERT INTO products (codigo, nombre) VALUES (?1, 'Producto de prueba')",
    args: [codigo],
  });
  return Number(result.lastInsertRowid);
}

function minimalItem(nombre: string): PrintItem {
  return {
    nombre,
    tamano_extendido: "",
    tamano_final: "",
    tintas: "",
    tipo_papel: "",
    gramos_puntos: "",
    pliego: "",
    cortes_tamano: "",
    maquina: "",
    formacion: "",
    numero_pliegos: "",
    numero_placas: "",
    placas_existentes: "",
    checks: [],
    extras: [],
    images: [],
    acabados: "",
    notas: "",
    orden: 1,
  };
}

describe("savePrintItems — atomicidad", () => {
  it("guarda un item nuevo junto con sus checks/extras/images en una sola operación", async () => {
    const productId = await seedProduct("IMPRENTA-1");
    const a = await actor();

    await savePrintItems(a, productId, [
      {
        ...minimalItem("Volante A5"),
        checks: [{ nombre: "Suaje", marcado: true, orden: 1 }],
        extras: [{ etiqueta: "Barniz", valor: "UV", orden: 1 }],
      },
    ]);

    const items = await getPrintItems(productId);
    expect(items).toHaveLength(1);
    expect(items[0].checks.find((c) => c.nombre === "Suaje")?.marcado).toBe(true);
    expect(items[0].extras).toHaveLength(1);
  });

  it("es atómico: si falla a mitad de camino (checks), no deja el item principal huérfano (rollback real, no solo un error reportado)", async () => {
    const productId = await seedProduct("IMPRENTA-ROLLBACK");
    const a = await actor();
    const raw = rawClient();

    // Fuerza el fallo de un statement que corre DESPUÉS del INSERT/UPDATE
    // principal de product_print_items, sin tocar el esquema de producción:
    // renombra la tabla lejos del nombre esperado y la restaura en el finally.
    await raw.execute("ALTER TABLE product_print_item_checks RENAME TO product_print_item_checks_tmp");
    try {
      await expect(savePrintItems(a, productId, [minimalItem("Item que no debería quedar")])).rejects.toThrow();
    } finally {
      await raw.execute("ALTER TABLE product_print_item_checks_tmp RENAME TO product_print_item_checks");
    }

    expect(await countRows("product_print_items", "product_id = ?1", [productId])).toBe(0);
  });

  it("es atómico también al limpiar items eliminados: si falla a mitad de la limpieza, el item existente no queda a medio borrar", async () => {
    const productId = await seedProduct("IMPRENTA-ROLLBACK-2");
    const a = await actor();
    await savePrintItems(a, productId, [
      { ...minimalItem("Item original"), checks: [{ nombre: "Suaje", marcado: true, orden: 1 }] },
    ]);
    const [existing] = await getPrintItems(productId);

    const raw = rawClient();
    // Guardar con una lista vacía dispara la limpieza de "items eliminados"
    // (el bloque final de savePrintItems) — forzamos su fallo a mitad de
    // camino renombrando una de las tablas que borra.
    await raw.execute("ALTER TABLE product_print_item_orders RENAME TO product_print_item_orders_tmp");
    try {
      await expect(savePrintItems(a, productId, [])).rejects.toThrow();
    } finally {
      await raw.execute("ALTER TABLE product_print_item_orders_tmp RENAME TO product_print_item_orders");
    }

    // El item original debe seguir intacto: ni borrado a medias, ni sus
    // checks huérfanos.
    const itemsAfter = await getPrintItems(productId);
    expect(itemsAfter).toHaveLength(1);
    expect(itemsAfter[0].id).toBe(existing.id);
    expect(itemsAfter[0].checks.find((c) => c.nombre === "Suaje")?.marcado).toBe(true);
  });
});

describe("createPrintItemPurchasesBatch — atomicidad de la 'compra general' (OrderModal)", () => {
  async function seedOrder(): Promise<number> {
    const productId = await seedProduct(`ORDER-${Math.random().toString(36).slice(2)}`);
    const a = await actor();
    await savePrintItems(a, productId, [minimalItem("Item con orden")]);
    const [item] = await getPrintItems(productId);
    const orderResult = await rawClient().execute({
      sql: `INSERT INTO product_print_item_orders (print_item_id, total_pliegos) VALUES (?1, 100)`,
      args: [item.id as number],
    });
    return Number(orderResult.lastInsertRowid);
  }

  function entry(printItemOrderId: number, folio: string) {
    return {
      printItemOrderId,
      papel: "Bond 90g",
      pliego: "70x100",
      maquina: "Máquina 1",
      cortes: 4,
      cantidad: 25,
      totalTamanos: 100,
      folio,
    };
  }

  it("rechaza a un usuario sin el permiso imprenta, sin guardar ninguna compra", async () => {
    const orderId = await seedOrder();
    const user = await createFixtureUser({ username: "sinimprenta_compra", permisos: [] });
    await expect(
      createPrintItemPurchasesBatch(user, [entry(orderId, "COMPRA-1")]),
    ).rejects.toThrow(/no autorizado/i);
    expect(await countRows("product_print_item_purchases")).toBe(0);
  });

  it("es todo o nada: si el guardado falla a mitad de la lista, ninguna compra de ese lote queda guardada (no solo un 'mejor esfuerzo' parcial)", async () => {
    const orderId1 = await seedOrder();
    const orderId2 = await seedOrder();
    const a = await actor();
    const raw = rawClient();

    // Fuerza el fallo del statement sin depender de una constraint que este
    // esquema no declara (no hay FOREIGN KEY en product_print_item_purchases):
    // renombra la tabla destino lejos del nombre esperado, para que el
    // INSERT falle sin importar cuántas entradas ya se hayan procesado en la
    // misma transacción, y la restaura siempre en el finally.
    await raw.execute("ALTER TABLE product_print_item_purchases RENAME TO product_print_item_purchases_tmp");
    try {
      await expect(
        createPrintItemPurchasesBatch(a, [entry(orderId1, "COMPRA-2"), entry(orderId2, "COMPRA-2")]),
      ).rejects.toThrow();
    } finally {
      await raw.execute("ALTER TABLE product_print_item_purchases_tmp RENAME TO product_print_item_purchases");
    }

    // Ninguna debe haber quedado guardada — exactamente el escenario que
    // reportó la auditoría (un PDF podía listar compras que nunca quedaron
    // persistidas en la BD).
    expect(await countRows("product_print_item_purchases", "folio = ?1", ["COMPRA-2"])).toBe(0);
  });

  it("guarda todas las entradas cuando ninguna falla", async () => {
    const orderId = await seedOrder();
    const a = await actor();
    const result = await createPrintItemPurchasesBatch(a, [entry(orderId, "COMPRA-3")]);
    expect(result).toHaveLength(1);
    expect(await countRows("product_print_item_purchases", "folio = ?1", ["COMPRA-3"])).toBe(1);
  });
});

describe("updatePrintItemOrder — edición de órdenes históricas conservando folio", () => {
  async function seedOrder() {
    const productId = await seedProduct(`ORDEN-EDIT-${Math.random().toString(36).slice(2)}`);
    const a = await actor();
    await savePrintItems(a, productId, [minimalItem("Item para editar")]);
    const [item] = await getPrintItems(productId);
    const orderResult = await rawClient().execute({
      sql: `INSERT INTO product_print_item_orders
              (print_item_id, merma, cantidad_arte, numero_tiros, formacion_usada, numero_pliegos_usado, total_pliegos, usuario, folio)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      args: [item.id as number, 5, 100, 200, 4, 10, 260, "creador", "OP-000001"],
    });
    return { orderId: Number(orderResult.lastInsertRowid), a };
  }

  it("actualiza merma/cantidad de arte/tiros/formación/pliegos y recalcula el total, conservando folio/print_item_id/usuario/creado_en", async () => {
    const { orderId, a } = await seedOrder();
    const before = await rawClient().execute({
      sql: "SELECT * FROM product_print_item_orders WHERE id = ?1",
      args: [orderId],
    });
    const beforeRow = before.rows[0] as unknown as { folio: string; print_item_id: number; usuario: string; creado_en: string };

    const nuevoTotal = Math.ceil((150 / 4 + 8) * 10);
    const updated = await updatePrintItemOrder(a, orderId, {
      merma: 8,
      cantidadArte: 150,
      numeroTiros: 300,
      formacionUsada: 4,
      numeroPliegosUsado: 10,
      totalPliegos: nuevoTotal,
    });

    expect(updated.folio).toBe(beforeRow.folio);
    expect(updated.print_item_id).toBe(beforeRow.print_item_id);
    expect(updated.usuario).toBe(beforeRow.usuario);
    expect(updated.creado_en).toBe(beforeRow.creado_en);
    expect(updated.merma).toBe(8);
    expect(updated.cantidad_arte).toBe(150);
    expect(updated.numero_tiros).toBe(300);
    expect(updated.total_pliegos).toBe(nuevoTotal);
    expect(await countRows("product_print_item_orders")).toBe(1);
  });

  it("rechaza a un usuario sin el permiso imprenta, sin modificar la orden", async () => {
    const { orderId } = await seedOrder();
    const user = await createFixtureUser({ username: "sinimprenta_orden_edit", permisos: [] });
    await expect(
      updatePrintItemOrder(user, orderId, {
        merma: 1,
        cantidadArte: 1,
        numeroTiros: 1,
        formacionUsada: 1,
        numeroPliegosUsado: 1,
        totalPliegos: 1,
      }),
    ).rejects.toThrow(/no autorizado/i);
    const row = await rawClient().execute({
      sql: "SELECT merma FROM product_print_item_orders WHERE id = ?1",
      args: [orderId],
    });
    expect((row.rows[0] as unknown as { merma: number }).merma).toBe(5);
  });
});

describe("updatePrintItemPurchase — edición de compras históricas conservando folio", () => {
  async function seedPurchase() {
    const productId = await seedProduct(`COMPRA-EDIT-${Math.random().toString(36).slice(2)}`);
    const a = await actor();
    await savePrintItems(a, productId, [minimalItem("Item con compra")]);
    const [item] = await getPrintItems(productId);
    const orderResult = await rawClient().execute({
      sql: "INSERT INTO product_print_item_orders (print_item_id, total_pliegos) VALUES (?1, 200)",
      args: [item.id as number],
    });
    const orderId = Number(orderResult.lastInsertRowid);
    const purchaseResult = await rawClient().execute({
      sql: `INSERT INTO product_print_item_purchases
              (print_item_order_id, papel, pliego, maquina, cortes, cantidad, total_tamanos, usuario, folio)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      args: [orderId, "Bond 90g", "70x100", "Máquina 1", 4, 50, 200, "creador", "OC-000001"],
    });
    return { purchaseId: Number(purchaseResult.lastInsertRowid), a };
  }

  it("actualiza cortes/cantidad/total y recalcula, conservando folio/papel/pliego/máquina/usuario/creado_en", async () => {
    const { purchaseId, a } = await seedPurchase();
    const before = await rawClient().execute({
      sql: "SELECT * FROM product_print_item_purchases WHERE id = ?1",
      args: [purchaseId],
    });
    const beforeRow = before.rows[0] as unknown as {
      folio: string;
      papel: string;
      pliego: string;
      maquina: string;
      usuario: string;
      creado_en: string;
    };

    const updated = await updatePrintItemPurchase(a, purchaseId, { cortes: 5, cantidad: 40, totalTamanos: 200 });

    expect(updated.folio).toBe(beforeRow.folio);
    expect(updated.papel).toBe(beforeRow.papel);
    expect(updated.pliego).toBe(beforeRow.pliego);
    expect(updated.maquina).toBe(beforeRow.maquina);
    expect(updated.usuario).toBe(beforeRow.usuario);
    expect(updated.creado_en).toBe(beforeRow.creado_en);
    expect(updated.cortes).toBe(5);
    expect(updated.cantidad).toBe(40);
    expect(updated.total_tamanos).toBe(200);
    expect(await countRows("product_print_item_purchases")).toBe(1);
  });

  it("rechaza a un usuario sin el permiso imprenta, sin modificar la compra", async () => {
    const { purchaseId } = await seedPurchase();
    const user = await createFixtureUser({ username: "sinimprenta_compra_edit", permisos: [] });
    await expect(
      updatePrintItemPurchase(user, purchaseId, { cortes: 1, cantidad: 1, totalTamanos: 1 }),
    ).rejects.toThrow(/no autorizado/i);
    const row = await rawClient().execute({
      sql: "SELECT cortes FROM product_print_item_purchases WHERE id = ?1",
      args: [purchaseId],
    });
    expect((row.rows[0] as unknown as { cortes: number }).cortes).toBe(4);
  });
});
