import { describe, expect, it } from "vitest";
import { classifyBarcodeFolders, pickBarcodeFile } from "../src/barcodeImageImport";
import type { BarcodeMatch, ImageFolderEntry } from "../src/db";

function files(...names: string[]): ImageFolderEntry[] {
  return names.map((name) => ({ name, path: `/carpeta/7501234567890/${name}` }));
}

describe("pickBarcodeFile — solo el archivo que es exactamente el número, sin guion adelante", () => {
  it("elige el archivo cuyo nombre (sin extensión) es igual al número de la carpeta", () => {
    const result = pickBarcodeFile("7501234567890", files("7501234567890.png"));
    expect(result).toEqual({ file: { name: "7501234567890.png", path: "/carpeta/7501234567890/7501234567890.png" } });
  });

  it("ignora un archivo con guion adelante de los números", () => {
    const result = pickBarcodeFile("7501234567890", files("-7501234567890.png"));
    expect(result).toEqual({ error: expect.stringContaining("No se encontró") });
  });

  it("ignora un archivo con sufijo después de los números (no es solo dígitos)", () => {
    const result = pickBarcodeFile("7501234567890", files("7501234567890-alt.png"));
    expect(result).toEqual({ error: expect.stringContaining("No se encontró") });
  });

  it("ignora un archivo con extensión no soportada", () => {
    const result = pickBarcodeFile("7501234567890", files("7501234567890.pdf"));
    expect(result).toEqual({ error: expect.stringContaining("No se encontró") });
  });

  it("acepta svg además de los formatos raster", () => {
    const result = pickBarcodeFile("7501234567890", files("7501234567890.svg"));
    expect("file" in result && result.file.name).toBe("7501234567890.svg");
  });

  it("elige el correcto entre varios archivos de la misma carpeta", () => {
    const result = pickBarcodeFile(
      "7501234567890",
      files("-7501234567890.png", "7501234567890.png", "7501234567890-grande.png"),
    );
    expect("file" in result && result.file.name).toBe("7501234567890.png");
  });

  it("da error si hay más de un archivo que cumple la regla (ej. dos extensiones distintas)", () => {
    const result = pickBarcodeFile("7501234567890", files("7501234567890.png", "7501234567890.svg"));
    expect(result).toEqual({ error: expect.stringContaining("más de un archivo válido") });
  });

  it("no confunde el número de otra carpeta con el de esta", () => {
    const result = pickBarcodeFile("7501234567890", files("1112223334445.png"));
    expect(result).toEqual({ error: expect.stringContaining("No se encontró") });
  });
});

describe("classifyBarcodeFolders", () => {
  const folder: ImageFolderEntry = { name: "7501234567890", path: "/raiz/7501234567890" };
  const validFile: ImageFolderEntry = { name: "7501234567890.png", path: "/raiz/7501234567890/7501234567890.png" };

  function matchFor(overrides: Partial<BarcodeMatch> = {}): BarcodeMatch {
    return { id: 1, codigo: "3072", nombre: "Tangram", tieneImagenBarras: false, ...overrides };
  }

  it("carpeta sin archivo válido queda en error, sin llegar a buscar el producto", () => {
    const rows = classifyBarcodeFolders(
      [folder],
      new Map([[folder.path, files("-7501234567890.png")]]),
      new Map([[folder.name, [matchFor()]]]),
    );
    expect(rows[0].status).toBe("error");
    expect(rows[0].matchedProduct).toBeUndefined();
  });

  it("carpeta con archivo válido pero ninguna ficha con ese código de barras -> no-encontrado", () => {
    const rows = classifyBarcodeFolders(
      [folder],
      new Map([[folder.path, [validFile]]]),
      new Map([[folder.name, []]]),
    );
    expect(rows[0].status).toBe("no-encontrado");
    expect(rows[0].archivo).toBe("7501234567890.png");
  });

  it("una sola ficha coincidente sin imagen previa -> nueva", () => {
    const rows = classifyBarcodeFolders(
      [folder],
      new Map([[folder.path, [validFile]]]),
      new Map([[folder.name, [matchFor({ tieneImagenBarras: false })]]]),
    );
    expect(rows[0].status).toBe("nueva");
    expect(rows[0].matchedProduct?.codigo).toBe("3072");
  });

  it("una sola ficha coincidente que ya tiene imagen de código de barras -> sustituir", () => {
    const rows = classifyBarcodeFolders(
      [folder],
      new Map([[folder.path, [validFile]]]),
      new Map([[folder.name, [matchFor({ tieneImagenBarras: true })]]]),
    );
    expect(rows[0].status).toBe("sustituir");
  });

  it("más de una ficha con el mismo código de barras -> error, no se adivina cuál usar", () => {
    const rows = classifyBarcodeFolders(
      [folder],
      new Map([[folder.path, [validFile]]]),
      new Map([[folder.name, [matchFor({ id: 1, codigo: "3072" }), matchFor({ id: 2, codigo: "3073" })]]]),
    );
    expect(rows[0].status).toBe("error");
    expect(rows[0].reason).toContain("3072");
    expect(rows[0].reason).toContain("3073");
  });
});
