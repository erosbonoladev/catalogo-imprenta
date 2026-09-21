import { beforeEach, describe, expect, it } from "vitest";
import { createProduct, upsertPendingProductBarcodeImage } from "../src/db";
import { createFixtureUser, rawClient, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

async function actorAdmin() {
  return createFixtureUser({ username: "admin-barcode-import", rol: "admin" });
}

const base = {
  categoria: "",
  material: "",
  descripcion: "",
  imagen: null,
  imagen_codigo_barras: null,
  tipo_producto: "",
};

describe("Imágenes de código de barras pendientes: upsertPendingProductBarcodeImage + applyPendingProductBarcodeImage (vía createProduct)", () => {
  it("guarda la imagen pendiente cuando el código de barras no tiene ficha todavía", async () => {
    const actor = await actorAdmin();
    await upsertPendingProductBarcodeImage(actor, {
      codigoBarras: "7501234567890",
      imagen: { data: new Uint8Array([1, 2, 3]), mime: "image/png" },
      archivoOriginal: "7501234567890.png",
      usuario: "tester",
    });

    const row = await rawClient().execute({
      sql: "SELECT codigo_barras, imagen_mime, archivo_original FROM pending_product_barcode_images WHERE codigo_barras = ?1",
      args: ["7501234567890"],
    });
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({ codigo_barras: "7501234567890", imagen_mime: "image/png" });
  });

  it("se aplica sola al crear un producto con ese código de barras, y se borra de pendientes", async () => {
    const actor = await actorAdmin();
    await upsertPendingProductBarcodeImage(actor, {
      codigoBarras: "7501234567890",
      imagen: { data: new Uint8Array([1, 2, 3, 4]), mime: "image/svg+xml" },
      archivoOriginal: "7501234567890.svg",
      usuario: "tester",
    });

    const productId = await createProduct(
      actor,
      { ...base, codigo: "BC1", nombre: "Producto agregado a futuro", codigo_barras_texto: "7501234567890" },
      [],
    );

    const product = await rawClient().execute({
      sql: "SELECT imagen_codigo_barras_mime FROM products WHERE id = ?1",
      args: [productId],
    });
    expect(product.rows[0].imagen_codigo_barras_mime).toBe("image/svg+xml");

    const pending = await rawClient().execute({
      sql: "SELECT id FROM pending_product_barcode_images WHERE codigo_barras = ?1",
      args: ["7501234567890"],
    });
    expect(pending.rows).toHaveLength(0);
  });

  it("no pisa una imagen de código de barras que la propia alta ya trae", async () => {
    const actor = await actorAdmin();
    await upsertPendingProductBarcodeImage(actor, {
      codigoBarras: "1112223334445",
      imagen: { data: new Uint8Array([9, 9, 9]), mime: "image/png" },
      archivoOriginal: "1112223334445.png",
      usuario: "tester",
    });

    const productId = await createProduct(
      actor,
      {
        ...base,
        codigo: "BC2",
        nombre: "Producto con imagen de código de barras propia",
        codigo_barras_texto: "1112223334445",
        imagen_codigo_barras: { data: new Uint8Array([5, 5, 5]), mime: "image/webp" },
      },
      [],
    );

    const product = await rawClient().execute({
      sql: "SELECT imagen_codigo_barras_mime FROM products WHERE id = ?1",
      args: [productId],
    });
    // Conserva la que trajo el alta (webp), no la pendiente (png).
    expect(product.rows[0].imagen_codigo_barras_mime).toBe("image/webp");
  });

  it("reimportar el mismo código de barras sin ficha reemplaza la imagen pendiente anterior, no la duplica", async () => {
    const actor = await actorAdmin();
    await upsertPendingProductBarcodeImage(actor, {
      codigoBarras: "6666666666666",
      imagen: { data: new Uint8Array([1]), mime: "image/png" },
      archivoOriginal: "6666666666666-v1.png",
      usuario: "tester",
    });
    await upsertPendingProductBarcodeImage(actor, {
      codigoBarras: "6666666666666",
      imagen: { data: new Uint8Array([2]), mime: "image/svg+xml" },
      archivoOriginal: "6666666666666-v2.svg",
      usuario: "tester",
    });

    const rows = await rawClient().execute({
      sql: "SELECT imagen_mime, archivo_original FROM pending_product_barcode_images WHERE codigo_barras = ?1",
      args: ["6666666666666"],
    });
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ imagen_mime: "image/svg+xml", archivo_original: "6666666666666-v2.svg" });
  });

  it("crear un producto sin código de barras no toca pending_product_barcode_images", async () => {
    const actor = await actorAdmin();
    await upsertPendingProductBarcodeImage(actor, {
      codigoBarras: "7501234567890",
      imagen: { data: new Uint8Array([1]), mime: "image/png" },
      archivoOriginal: "7501234567890.png",
      usuario: "tester",
    });

    await createProduct(actor, { ...base, codigo: "BC3", nombre: "Sin código de barras", codigo_barras_texto: "" }, []);

    const pending = await rawClient().execute({
      sql: "SELECT id FROM pending_product_barcode_images WHERE codigo_barras = ?1",
      args: ["7501234567890"],
    });
    expect(pending.rows).toHaveLength(1);
  });
});
