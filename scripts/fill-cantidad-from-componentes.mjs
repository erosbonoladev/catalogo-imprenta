// One-off migration: copia plastic_products.componentes_fabricacion a
// product_plastic_items.cantidad SOLO en los vínculos ficha↔pieza cuya
// cantidad está vacía (o solo espacios) y cuya pieza sí trae componentes. Un
// vínculo con cantidad ya capturada no se toca nunca. Motivo: "Componentes de
// fabricación" se quita del formulario de Piezas y la hoja Recetas muestra
// "Cantidad" (decisión del usuario, 2026-10-16).
//
// Por defecto es SIMULACIÓN. Para aplicar:
//   node scripts/fill-cantidad-from-componentes.mjs --apply --backup <archivo.json>
// --backup guarda (id, cantidad anterior) de cada vínculo que se va a escribir.
// Seguro de correr más de una vez (la segunda vez no encuentra nada vacío).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const backupIdx = args.indexOf("--backup");
const backupPath = backupIdx >= 0 ? args[backupIdx + 1] : null;

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
const client = createClient({ url: env.VITE_TURSO_URL, authToken: env.VITE_TURSO_AUTH_TOKEN });

async function main() {
  if (apply && !backupPath) throw new Error("--apply exige --backup <archivo.json>");

  const total = Number(
    (await client.execute("SELECT COUNT(*) n FROM product_plastic_items")).rows[0].n,
  );
  const conCantidad = Number(
    (await client.execute("SELECT COUNT(*) n FROM product_plastic_items WHERE TRIM(COALESCE(cantidad, '')) <> ''")).rows[0].n,
  );
  const candidatos = (
    await client.execute(
      `SELECT ppi.id, ppi.cantidad, TRIM(pp.componentes_fabricacion) AS componentes
       FROM product_plastic_items ppi
       JOIN plastic_products pp ON pp.id = ppi.plastic_product_id
       WHERE TRIM(COALESCE(ppi.cantidad, '')) = ''
         AND TRIM(COALESCE(pp.componentes_fabricacion, '')) <> ''
       ORDER BY ppi.id`,
    )
  ).rows.map((r) => ({ id: Number(r.id), cantidad: r.cantidad, componentes: String(r.componentes) }));

  console.log(`Vínculos ficha↔pieza: ${total} (${conCantidad} ya con Cantidad — no se tocan).`);
  console.log(`A rellenar con Componentes de fabricación: ${candidatos.length}.`);
  console.log(`Quedarían sin Cantidad (pieza sin componentes): ${total - conCantidad - candidatos.length}.`);

  if (!apply) {
    console.log("SIMULACIÓN — no se escribió nada. Usá --apply --backup <archivo.json> para aplicar.");
    return;
  }

  writeFileSync(backupPath, JSON.stringify(candidatos, null, 2));
  console.log(`Respaldo escrito en ${backupPath}`);

  const CHUNK = 200;
  for (let i = 0; i < candidatos.length; i += CHUNK) {
    await client.batch(
      candidatos.slice(i, i + CHUNK).map((c) => ({
        // La condición de vacío se repite: si alguien capturó la cantidad
        // entre la lectura y la escritura, no se pisa.
        sql: "UPDATE product_plastic_items SET cantidad = ?1 WHERE id = ?2 AND TRIM(COALESCE(cantidad, '')) = ''",
        args: [c.componentes, c.id],
      })),
      "write",
    );
  }
  console.log("Listo.");
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
