import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { LICENSING_SCHEMA_STATEMENTS, MAIN_SCHEMA_STATEMENTS } from "./schema";
import { rawLicensingClient, rawMainClient, LICENSING_DB_PATH, MAIN_DB_PATH } from "./helpers";

for (const path of [LICENSING_DB_PATH, MAIN_DB_PATH]) {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(`${path}${suffix}`, { force: true });
  }
  mkdirSync(dirname(path), { recursive: true });
}

const licensing = rawLicensingClient();
for (const statement of LICENSING_SCHEMA_STATEMENTS) {
  await licensing.execute(statement);
}

const main = rawMainClient();
for (const statement of MAIN_SCHEMA_STATEMENTS) {
  await main.execute(statement);
}
