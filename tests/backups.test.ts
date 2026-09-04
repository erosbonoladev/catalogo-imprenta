import { beforeEach, describe, expect, it } from "vitest";
import {
  buildBackupSql,
  extractRestoreStatements,
  validateBackupSql,
  validateRestoreStatements,
  type DumpTable,
} from "../src/backup";
import { executeRestoreSql } from "../src/db";
import { countRows, createFixtureUser, rawClient, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

function sampleTable(): DumpTable {
  return {
    name: "precios",
    createSql: "CREATE TABLE precios (id INTEGER PRIMARY KEY, sku TEXT)",
    columns: ["id", "sku"],
    rows: [
      { id: 1, sku: "A1" },
      { id: 2, sku: "A2" },
    ],
  };
}

describe("validateBackupSql (estructural)", () => {
  it("acepta un dump recién armado por buildBackupSql", () => {
    const { sql } = buildBackupSql([sampleTable()]);
    const result = validateBackupSql(sql);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rechaza un archivo sin el encabezado de metadata", () => {
    const result = validateBackupSql("BEGIN TRANSACTION;\nCOMMIT;\n");
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /metadatos/i.test(e))).toBe(true);
  });

  it("rechaza si el conteo de filas no coincide con el manifiesto", () => {
    const { sql } = buildBackupSql([sampleTable()]);
    const tampered = sql.replace("INSERT INTO precios (id, sku) VALUES (2, 'A2');\n", "");
    const result = validateBackupSql(tampered);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /precios.*1.*se esperaban 2/i.test(e))).toBe(true);
  });
});

describe("validateRestoreStatements (subconjunto seguro de restauración)", () => {
  const knownTables = ["products", "precios", "users"];

  it("acepta DROP TABLE IF EXISTS / CREATE TABLE / INSERT INTO sobre tablas conocidas", () => {
    const statements = [
      "DROP TABLE IF EXISTS precios",
      "CREATE TABLE precios (id INTEGER PRIMARY KEY, sku TEXT)",
      "INSERT INTO precios (id, sku) VALUES (1, 'A1')",
    ];
    expect(validateRestoreStatements(statements, knownTables)).toEqual({ ok: true, errors: [] });
  });

  it("acepta CREATE TABLE IF NOT EXISTS (forma real usada por varias tablas de producción)", () => {
    const statements = ["CREATE TABLE IF NOT EXISTS precios (id INTEGER PRIMARY KEY)"];
    expect(validateRestoreStatements(statements, knownTables).ok).toBe(true);
  });

  it("rechaza statements fuera del subconjunto (UPDATE/DELETE/ATTACH)", () => {
    for (const stmt of [
      "UPDATE users SET rol = 'admin' WHERE id = 1",
      "DELETE FROM users",
      "ATTACH DATABASE 'evil.db' AS evil",
      "CREATE TRIGGER evil AFTER INSERT ON users BEGIN SELECT 1; END",
    ]) {
      const result = validateRestoreStatements([stmt], knownTables);
      expect(result.ok).toBe(false);
    }
  });

  it("rechaza una tabla que no existe en la BD en vivo, aunque el statement tenga forma válida", () => {
    const result = validateRestoreStatements(["INSERT INTO tabla_inventada (id) VALUES (1)"], knownTables);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/tabla desconocida/i);
  });
});

describe("executeRestoreSql — integración contra la BD en vivo", () => {
  async function actorConRestaurar() {
    return createFixtureUser({ username: "restaurador", permisos: ["backups_restaurar"] });
  }

  it("rechaza un dump manipulado con un statement fuera del subconjunto seguro, sin tocar la BD", async () => {
    await rawClient().execute(
      "INSERT INTO users (username, password_hash, rol) VALUES ('victima', 'x', 'usuario')",
    );
    const a = await actorConRestaurar();

    const malicioso = `-- CLIO_BACKUP_META {"version":1,"creadoEn":"2026-01-01T00:00:00.000Z","tablas":{}}
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
UPDATE users SET rol='admin' WHERE username='victima';
COMMIT;
`;

    await expect(executeRestoreSql(a, malicioso)).rejects.toThrow(/rechazado/i);

    const victima = await rawClient().execute({
      sql: "SELECT rol FROM users WHERE username = 'victima'",
      args: [],
    });
    expect(victima.rows[0]?.rol).toBe("usuario");
  });

  it("restaura un dump real generado por buildBackupSql (DROP+CREATE+INSERT de punta a punta)", async () => {
    const a = await actorConRestaurar();
    const table: DumpTable = {
      name: "test_scratch",
      createSql: "CREATE TABLE test_scratch (id INTEGER PRIMARY KEY, valor TEXT)",
      columns: ["id", "valor"],
      rows: [{ id: 1, valor: "Restaurado" }],
    };
    const { sql } = buildBackupSql([table]);

    await executeRestoreSql(a, sql);

    expect(await countRows("test_scratch")).toBe(1);
    const restored = await rawClient().execute("SELECT * FROM test_scratch");
    expect(restored.rows[0]).toMatchObject({ id: 1, valor: "Restaurado" });
  });

  it("extractRestoreStatements descarta PRAGMA/BEGIN/COMMIT/comentarios de control", () => {
    const { sql } = buildBackupSql([sampleTable()]);
    const statements = extractRestoreStatements(sql);
    expect(statements.some((s) => /^PRAGMA/i.test(s))).toBe(false);
    expect(statements.some((s) => /^BEGIN/i.test(s))).toBe(false);
    expect(statements.some((s) => /^COMMIT/i.test(s))).toBe(false);
    expect(statements.some((s) => s.startsWith("--"))).toBe(false);
  });
});
