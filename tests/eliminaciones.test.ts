import { beforeEach, describe, expect, it } from "vitest";
import { deletePlasticProduct, deleteProduct } from "../src/db";
import { countRows, createFixtureUser, rawClient, resetDb, type FixtureUser } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

async function seedFullProduct(): Promise<number> {
  const client = rawClient();
  const productResult = await client.execute({
    sql: `INSERT INTO products (codigo, nombre, categoria, material, descripcion)
          VALUES ('DEL-1', 'Producto a borrar', 'Cat', 'Mat', 'Desc')`,
  });
  const productId = Number(productResult.lastInsertRowid);

  await client.execute({
    sql: "INSERT INTO product_specs (product_id, etiqueta, valor, orden) VALUES (?1, 'Spec', 'Valor', 1)",
    args: [productId],
  });
  await client.execute({
    sql: "INSERT INTO product_descriptions (product_id, etiqueta, texto, orden) VALUES (?1, 'Desc', 'Texto', 1)",
    args: [productId],
  });

  const plasticResult = await client.execute(
    "INSERT INTO plastic_products (nombre, sku) VALUES ('Pieza', 'PZ-1')",
  );
  const plasticId = Number(plasticResult.lastInsertRowid);
  await client.execute({
    sql: "INSERT INTO product_plastic_items (product_id, plastic_product_id, orden) VALUES (?1, ?2, 1)",
    args: [productId, plasticId],
  });

  const printItemResult = await client.execute({
    sql: "INSERT INTO product_print_items (product_id, nombre, orden) VALUES (?1, 'Item', 1)",
    args: [productId],
  });
  const printItemId = Number(printItemResult.lastInsertRowid);
  await client.execute({
    sql: "INSERT INTO product_print_item_checks (print_item_id, nombre, marcado, orden) VALUES (?1, 'Check', 0, 1)",
    args: [printItemId],
  });
  await client.execute({
    sql: "INSERT INTO product_print_item_extras (print_item_id, etiqueta, valor, orden) VALUES (?1, 'Extra', 'Valor', 1)",
    args: [printItemId],
  });
  await client.execute({
    sql: "INSERT INTO product_print_item_images (print_item_id, orden) VALUES (?1, 1)",
    args: [printItemId],
  });
  const orderResult = await client.execute({
    sql: "INSERT INTO product_print_item_orders (print_item_id, folio) VALUES (?1, 'FOLIO-1')",
    args: [printItemId],
  });
  const orderId = Number(orderResult.lastInsertRowid);
  await client.execute({
    sql: "INSERT INTO product_print_item_purchases (print_item_order_id, folio) VALUES (?1, 'FOLIO-2')",
    args: [orderId],
  });

  return productId;
}

async function actorWithSession(): Promise<FixtureUser> {
  return createFixtureUser({ username: "borrador", permisos: [] });
}

describe("deleteProduct — cascada transaccional", () => {
  it("borra el producto y toda su cascada de una sola vez", async () => {
    const productId = await seedFullProduct();
    const actor = await actorWithSession();

    await deleteProduct(actor, productId);

    expect(await countRows("products")).toBe(0);
    expect(await countRows("product_specs")).toBe(0);
    expect(await countRows("product_descriptions")).toBe(0);
    expect(await countRows("product_plastic_items")).toBe(0);
    expect(await countRows("product_print_items")).toBe(0);
    expect(await countRows("product_print_item_checks")).toBe(0);
    expect(await countRows("product_print_item_extras")).toBe(0);
    expect(await countRows("product_print_item_images")).toBe(0);
    expect(await countRows("product_print_item_orders")).toBe(0);
    expect(await countRows("product_print_item_purchases")).toBe(0);
    // La pieza del catálogo maestro (plastic_products) NO se borra —
    // deleteProduct solo quita el vínculo (product_plastic_items).
    expect(await countRows("plastic_products")).toBe(1);
  });

  it("si un paso de la cascada falla, no deja nada a medias (rollback completo)", async () => {
    const productId = await seedFullProduct();
    const actor = await actorWithSession();
    const client = rawClient();

    // Fuerza que el DELETE de product_print_item_purchases (uno de los
    // últimos pasos de la cascada) falle siempre — simula una falla a
    // mitad de la transacción para verificar que TODO se revierte, no solo
    // lo que faltaba por borrar.
    await client.execute(`
      CREATE TRIGGER fail_purchase_delete
      BEFORE DELETE ON product_print_item_purchases
      BEGIN SELECT RAISE(ABORT, 'fallo forzado de prueba'); END
    `);

    await expect(deleteProduct(actor, productId)).rejects.toThrow();

    // Nada debe haberse borrado — ni siquiera lo que la cascada quita
    // primero (specs/descriptions), porque todo corrió en una transacción.
    expect(await countRows("products", "id = ?1", [productId])).toBe(1);
    expect(await countRows("product_specs", "product_id = ?1", [productId])).toBe(1);
    expect(await countRows("product_descriptions", "product_id = ?1", [productId])).toBe(1);
    expect(await countRows("product_plastic_items", "product_id = ?1", [productId])).toBe(1);
    expect(await countRows("product_print_items", "product_id = ?1", [productId])).toBe(1);
    expect(await countRows("product_print_item_purchases")).toBe(1);

    await client.execute("DROP TRIGGER fail_purchase_delete");
  });
});

describe("deletePlasticProduct — cascada transaccional", () => {
  it("borra la pieza y sus vínculos de una sola vez", async () => {
    const client = rawClient();
    const productResult = await client.execute(
      "INSERT INTO products (codigo, nombre) VALUES ('DEL-2', 'Producto')",
    );
    const productId = Number(productResult.lastInsertRowid);
    const plasticResult = await client.execute(
      "INSERT INTO plastic_products (nombre, sku) VALUES ('Pieza 2', 'PZ-2')",
    );
    const plasticId = Number(plasticResult.lastInsertRowid);
    await client.execute({
      sql: "INSERT INTO product_plastic_items (product_id, plastic_product_id, orden) VALUES (?1, ?2, 1)",
      args: [productId, plasticId],
    });

    const actor = await createFixtureUser({ username: "borrapieza", permisos: ["plasticos"] });
    await deletePlasticProduct(actor, plasticId);

    expect(await countRows("plastic_products", "id = ?1", [plasticId])).toBe(0);
    expect(await countRows("product_plastic_items", "plastic_product_id = ?1", [plasticId])).toBe(0);
    // El producto (ficha técnica) en sí no se toca.
    expect(await countRows("products", "id = ?1", [productId])).toBe(1);
  });
});
