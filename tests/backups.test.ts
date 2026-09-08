import { beforeEach, describe, expect, it } from "vitest";
import {
  buildBackupSql,
  extractRestoreStatements,
  validateBackupSql,
  validateRestoreStatements,
  type DumpIndex,
  type DumpTable,
} from "../src/backup";
import { createBackupSql, executeRestoreSql, verifyRestoreCounts } from "../src/db";
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

describe("índices — captura, dump y restauración (integridad de backup)", () => {
  function sampleIndex(): DumpIndex {
    return {
      name: "idx_precios_sku",
      tableName: "precios",
      createSql: "CREATE UNIQUE INDEX idx_precios_sku ON precios (sku)",
    };
  }

  it("buildBackupSql incluye el CREATE INDEX después de las filas de su tabla y lo lista en el manifiesto", () => {
    const { sql, manifest } = buildBackupSql([sampleTable()], [sampleIndex()]);
    expect(manifest.indices).toEqual(["idx_precios_sku"]);
    expect(sql).toContain("CREATE UNIQUE INDEX idx_precios_sku ON precios (sku);");
    // El índice va después del último INSERT de su tabla.
    const lastInsert = sql.lastIndexOf("INSERT INTO precios");
    const indexPos = sql.indexOf("CREATE UNIQUE INDEX idx_precios_sku");
    expect(indexPos).toBeGreaterThan(lastInsert);
  });

  it("validateRestoreStatements acepta CREATE UNIQUE INDEX sobre una tabla conocida", () => {
    const result = validateRestoreStatements(
      ["CREATE UNIQUE INDEX idx_precios_sku ON precios (sku)"],
      ["precios"],
    );
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("validateRestoreStatements rechaza un CREATE INDEX sobre una tabla desconocida", () => {
    const result = validateRestoreStatements(
      ["CREATE UNIQUE INDEX idx_evil ON tabla_inventada (x)"],
      ["precios"],
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/tabla desconocida/i);
  });

  it("validateBackupSql rechaza si el conteo de índices no coincide con el manifiesto", () => {
    const { sql } = buildBackupSql([sampleTable()], [sampleIndex()]);
    const tampered = sql.replace("CREATE UNIQUE INDEX idx_precios_sku ON precios (sku);\n", "");
    const result = validateBackupSql(tampered);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /número de índices/i.test(e))).toBe(true);
  });

  it("createBackupSql (contra la BD real de pruebas) captura un índice único creado por separado, y restaurarlo lo recrea", async () => {
    const raw = rawClient();
    await raw.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_test_users_username ON users (username)");

    const { sql, manifest } = await createBackupSql();
    expect(manifest.indices).toContain("idx_test_users_username");
    expect(sql).toContain("CREATE UNIQUE INDEX idx_test_users_username ON users (username)");

    // Se borra para simular exactamente lo que reportaba la auditoría: un
    // restore que hoy perdía los índices porque nunca se capturaban.
    await raw.execute("DROP INDEX idx_test_users_username");
    const before = await raw.execute(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_test_users_username'",
    );
    expect(before.rows.length).toBe(0);

    const a = await createFixtureUser({ username: "restaurador_idx", permisos: ["backups_restaurar"] });
    await executeRestoreSql(a, sql);

    const after = await raw.execute(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_test_users_username'",
    );
    expect(after.rows.length).toBe(1);

    const verification = await verifyRestoreCounts(manifest);
    expect(verification.ok).toBe(true);
    expect(verification.mismatches).toEqual([]);

    await raw.execute("DROP INDEX IF EXISTS idx_test_users_username");
  });

  it("createBackupSql lee todas las tablas desde una foto consistente (transacción de lectura), no consultas sueltas", async () => {
    // No hay forma directa de forzar una escritura concurrente a mitad del
    // dump en este entorno de pruebas de un solo proceso; esta prueba
    // confirma al menos que la función sigue funcionando de punta a punta
    // (no revienta al usar client.transaction("read")) y que el resultado es
    // internamente consistente con lo que hay en la BD en el momento de la
    // llamada.
    const before = await countRows("precios");
    const { manifest } = await createBackupSql();
    expect(manifest.tablas.precios).toBe(before);
  });
});

describe("validateBackupSql / validateRestoreStatements — simetría ante palabras peligrosas en datos", () => {
  it("un valor de texto que contiene la palabra VIEW no rompe la validación de creación ni la de restauración", () => {
    const table: DumpTable = {
      name: "precios",
      createSql: "CREATE TABLE precios (id INTEGER PRIMARY KEY, sku TEXT, nombre TEXT)",
      columns: ["id", "sku", "nombre"],
      rows: [{ id: 1, sku: "A1", nombre: "Cristal VIEW 4x4" }],
    };
    const { sql } = buildBackupSql([table]);

    const creationValidation = validateBackupSql(sql);
    expect(creationValidation.ok).toBe(true);
    expect(creationValidation.errors).toEqual([]);

    const restoreStatements = extractRestoreStatements(sql);
    const restoreValidation = validateRestoreStatements(restoreStatements, ["precios"]);
    expect(restoreValidation.ok).toBe(true);
    expect(restoreValidation.errors).toEqual([]);
  });

  it("un statement que realmente usa CREATE TRIGGER/VIEW fuera de un literal sigue siendo rechazado", () => {
    const malicious = "CREATE TRIGGER evil AFTER INSERT ON users BEGIN SELECT 1; END";
    expect(validateRestoreStatements([malicious], ["users"]).ok).toBe(false);
  });
});
