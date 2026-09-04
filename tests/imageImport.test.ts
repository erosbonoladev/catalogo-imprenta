import { beforeEach, describe, expect, it } from "vitest";
import {
  classifyImageEntries,
  fullStemFromFilename,
  skuFromFilename,
  type ImageFileEntry,
} from "../src/imageImport";
import { createProduct, upsertPendingProductImage } from "../src/db";
import { createFixtureUser, rawClient, resetDb } from "./helpers";
import type { Product } from "../src/types";

beforeEach(async () => {
  await resetDb();
});

describe("skuFromFilename — ejemplos reales de la carpeta de importación", () => {
  const cases: [string, string][] = [
    ["7145-Tapete-De-Texturas-AnimalesY-Sonidos.jpg", "7145"],
    ["7234Circulos-Del-Conocimiento-Quimica.png", "7234"],
    ["3061.jpg", "3061"],
    ["pl0025.webp", "pl0025"],
    ["7145 - Tapete De Texturas.jpg", "7145"],
  ];

  it.each(cases)("%s -> %s", (filename, expected) => {
    expect(skuFromFilename(filename)).toBe(expected);
  });
});

describe("classifyImageEntries — nombre completo tiene prioridad sobre el SKU recortado", () => {
  it("un código que ya trae guion propio (match exacto de archivo completo) no se rompe con la nueva regla", async () => {
    const client = rawClient();
    await client.execute("INSERT INTO products (codigo, nombre) VALUES ('ABC-123', 'Producto con guion')");
    const product = (
      await client.execute({ sql: "SELECT * FROM products WHERE codigo = ?1", args: ["ABC-123"] })
    ).rows[0] as unknown as Product;

    const entries: ImageFileEntry[] = [{ name: "ABC-123.jpg", path: "/tmp/ABC-123.jpg" }];
    // fullStemFromFilename("ABC-123.jpg") = "ABC-123" (coincide exacto);
    // skuFromFilename("ABC-123.jpg") = "ABC" (recorte, no coincide con nada).
    const lookups = new Map([
      [fullStemFromFilename(entries[0].name), product],
      [skuFromFilename(entries[0].name), null],
    ]);

    const rows = classifyImageEntries(entries, lookups);
    expect(rows[0].sku).toBe("ABC-123");
    expect(rows[0].status).toBe("nueva");
    expect(rows[0].matchedProduct?.codigo).toBe("ABC-123");
  });

  it("cuando el nombre completo no coincide, usa el SKU recortado del inicio", async () => {
    const client = rawClient();
    await client.execute("INSERT INTO products (codigo, nombre) VALUES ('7234', 'Circulos del conocimiento')");
    const product = (
      await client.execute({ sql: "SELECT * FROM products WHERE codigo = ?1", args: ["7234"] })
    ).rows[0] as unknown as Product;

    const entries: ImageFileEntry[] = [
      { name: "7234Circulos-Del-Conocimiento-Quimica.png", path: "/tmp/x.png" },
    ];
    const lookups = new Map([
      [fullStemFromFilename(entries[0].name), null],
      [skuFromFilename(entries[0].name), product],
    ]);

    const rows = classifyImageEntries(entries, lookups);
    expect(rows[0].sku).toBe("7234");
    expect(rows[0].status).toBe("nueva");
  });

  it("si ninguno de los dos coincide, queda 'no-encontrado' con el SKU recortado (no el nombre completo)", () => {
    const entries: ImageFileEntry[] = [{ name: "9999NoExiste.jpg", path: "/tmp/x.jpg" }];
    const lookups = new Map<string, Product | null>([
      [fullStemFromFilename(entries[0].name), null],
      [skuFromFilename(entries[0].name), null],
    ]);

    const rows = classifyImageEntries(entries, lookups);
    expect(rows[0].sku).toBe("9999");
    expect(rows[0].status).toBe("no-encontrado");
  });
});

describe("Imágenes pendientes: upsertPendingProductImage + applyPendingProductImage (vía createProduct)", () => {
  async function actorAdmin() {
    return createFixtureUser({ username: "admin-import", rol: "admin" });
  }

  it("guarda la imagen pendiente cuando el código no tiene ficha todavía", async () => {
    const actor = await actorAdmin();
    await upsertPendingProductImage(actor, {
      codigo: "8888",
      imagen: { data: new Uint8Array([1, 2, 3]), mime: "image/webp" },
      archivoOriginal: "8888-Futuro.webp",
      usuario: "tester",
    });

    const row = await rawClient().execute({
      sql: "SELECT codigo, imagen_mime, archivo_original FROM pending_product_images WHERE codigo = ?1",
      args: ["8888"],
    });
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({ codigo: "8888", imagen_mime: "image/webp" });
  });

  it("se aplica sola al crear un producto con ese código, y se borra de pendientes", async () => {
    const actor = await actorAdmin();
    await upsertPendingProductImage(actor, {
      codigo: "8888",
      imagen: { data: new Uint8Array([1, 2, 3, 4]), mime: "image/webp" },
      archivoOriginal: "8888-Futuro.webp",
      usuario: "tester",
    });

    const productId = await createProduct(
      actor,
      {
        codigo: "8888",
        nombre: "Producto agregado a futuro",
        categoria: "",
        material: "",
        descripcion: "",
        imagen: null,
        imagen_codigo_barras: null,
      },
      [],
    );

    const product = await rawClient().execute({
      sql: "SELECT imagen, imagen_mime FROM products WHERE id = ?1",
      args: [productId],
    });
    expect(product.rows[0].imagen_mime).toBe("image/webp");

    const pending = await rawClient().execute({
      sql: "SELECT id FROM pending_product_images WHERE codigo = ?1",
      args: ["8888"],
    });
    expect(pending.rows).toHaveLength(0);
  });

  it("no pisa una imagen que la propia alta ya trae", async () => {
    const actor = await actorAdmin();
    await upsertPendingProductImage(actor, {
      codigo: "7777",
      imagen: { data: new Uint8Array([9, 9, 9]), mime: "image/png" },
      archivoOriginal: "7777.png",
      usuario: "tester",
    });

    const productId = await createProduct(
      actor,
      {
        codigo: "7777",
        nombre: "Producto con imagen propia",
        categoria: "",
        material: "",
        descripcion: "",
        imagen: { data: new Uint8Array([5, 5, 5]), mime: "image/jpeg" },
        imagen_codigo_barras: null,
      },
      [],
    );

    const product = await rawClient().execute({
      sql: "SELECT imagen_mime FROM products WHERE id = ?1",
      args: [productId],
    });
    // Conserva la imagen que trajo el alta (jpeg), no la pendiente (png).
    expect(product.rows[0].imagen_mime).toBe("image/jpeg");
  });

  it("reimportar el mismo código sin ficha reemplaza la imagen pendiente anterior, no la duplica", async () => {
    const actor = await actorAdmin();
    await upsertPendingProductImage(actor, {
      codigo: "6666",
      imagen: { data: new Uint8Array([1]), mime: "image/png" },
      archivoOriginal: "6666-v1.png",
      usuario: "tester",
    });
    await upsertPendingProductImage(actor, {
      codigo: "6666",
      imagen: { data: new Uint8Array([2]), mime: "image/webp" },
      archivoOriginal: "6666-v2.webp",
      usuario: "tester",
    });

    const rows = await rawClient().execute({
      sql: "SELECT imagen_mime, archivo_original FROM pending_product_images WHERE codigo = ?1",
      args: ["6666"],
    });
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ imagen_mime: "image/webp", archivo_original: "6666-v2.webp" });
  });
});
