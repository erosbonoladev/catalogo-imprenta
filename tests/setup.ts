import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_STATEMENTS } from "./schema";
import { rawClient, TEST_DB_PATH } from "./helpers";

// Cada archivo de prueba corre en un módulo aislado (Vitest re-ejecuta
// setupFiles por archivo) — se recrea el SQLite local desde cero cada vez,
// nunca se reusa estado entre archivos. fileParallelism:false en
// vitest.config.ts asegura que no haya dos archivos escribiendo el mismo
// archivo físico a la vez.
for (const suffix of ["", "-journal", "-wal", "-shm"]) {
  rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
}
mkdirSync(dirname(TEST_DB_PATH), { recursive: true });

const client = rawClient();
for (const statement of SCHEMA_STATEMENTS) {
  await client.execute(statement);
}
