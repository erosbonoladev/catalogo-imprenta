// One-off migration for the requisición permission/config feature:
// - product_specs.permite_requisicion: per-spec opt-in for the "Requisición"
//   button (see src/components/ProductDetail.tsx). DEFAULT 1 backfills every
//   existing spec as enabled, preserving today's behavior (the button is
//   currently shown unconditionally on every spec).
// - products.actualizado_en: powers the "Última modificación" indicator;
//   backfilled from creado_en for products never edited since creation.
// - Grants the new 'requisiciones' permiso (see src/types.ts PERMISOS) to
//   every existing non-admin user, so nobody loses access to the button the
//   day this ships — an admin can revoke it per user afterwards from
//   Configuraciones → Usuarios.
//
// Safe to run more than once (checks PRAGMA table_info first, and the
// permission grant only inserts rows that don't already exist). Run with:
// node scripts/add-requisicion-config-fields.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

function loadEnv() {
  const text = readFileSync(join(rootDir, ".env"), "utf-8");
  const env = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

const env = loadEnv();
const client = createClient({
  url: env.VITE_TURSO_URL,
  authToken: env.VITE_TURSO_AUTH_TOKEN,
});

async function main() {
  const specsInfo = await client.execute("PRAGMA table_info(product_specs)");
  if (specsInfo.rows.some((row) => row.name === "permite_requisicion")) {
    console.log("product_specs.permite_requisicion ya existe — nada que hacer.");
  } else {
    await client.execute(
      "ALTER TABLE product_specs ADD COLUMN permite_requisicion INTEGER NOT NULL DEFAULT 1",
    );
    console.log("Columna product_specs.permite_requisicion agregada (existentes = activada).");
  }

  const productsInfo = await client.execute("PRAGMA table_info(products)");
  if (productsInfo.rows.some((row) => row.name === "actualizado_en")) {
    console.log("products.actualizado_en ya existe — nada que hacer.");
  } else {
    await client.execute("ALTER TABLE products ADD COLUMN actualizado_en TEXT");
    await client.execute(
      "UPDATE products SET actualizado_en = creado_en WHERE actualizado_en IS NULL",
    );
    console.log("Columna products.actualizado_en agregada y respaldada desde creado_en.");
  }

  const grant = await client.execute(`
    INSERT INTO user_permissions (user_id, permiso)
    SELECT id, 'requisiciones' FROM users
    WHERE rol != 'admin'
      AND id NOT IN (SELECT user_id FROM user_permissions WHERE permiso = 'requisiciones')
  `);
  console.log(`Permiso 'requisiciones' otorgado a ${grant.rowsAffected} usuario(s) existentes.`);
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
