// One-off migration: insumos en Piezas (plastic_products).
//  1. Agrega plastic_products.es_insumo (INTEGER NOT NULL DEFAULT 0).
//  2. Unifica las piezas con SKU INS-NNNN repetidas (la misma bolsa/insumo
//     cargada una vez por ficha) en UNA sola pieza maestra: las demás copias
//     se borran y sus vínculos ficha↔pieza (product_plastic_items, con su
//     cantidad) se reapuntan a la maestra. La maestra es la copia con más
//     campos capturados (empate: la de menor id); sus campos vacíos se
//     completan con los de las copias. No toca actualizado_en de la maestra,
//     para que "Exportar avance del día" no liste de golpe todas las fichas
//     que usan ese insumo.
//  3. Marca es_insumo = 1 en toda pieza con SKU INS-NNNN y crea el índice
//     único parcial (sku) WHERE es_insumo = 1 que impide repetirlos.
// Los ids borrados y la maestra también se quitan de piezas_import_batches (si
// no, "Eliminar última importación masiva" borraría una pieza ya compartida por
// muchas fichas, junto con todos sus vínculos).
//
// Por defecto es SIMULACIÓN (no escribe nada). Para aplicar:
//   node scripts/add-piezas-insumo-column.mjs --apply --backup <archivo.json>
// --backup guarda, antes de escribir, las filas y vínculos que se van a
// borrar/mover (para poder revertir a mano). Seguro de correr más de una vez.
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
const client = createClient({
  url: env.VITE_TURSO_URL,
  authToken: env.VITE_TURSO_AUTH_TOKEN,
});

const TEXT_COLUMNS = [
  "color",
  "origen",
  "descripcion",
  "armado",
  "dimension",
  "peso",
  "maquila",
  "coste",
  "componentes_fabricacion",
  "precio_por_pieza",
  "precio_por_juego",
];

const filled = (v) => v !== null && v !== undefined && String(v).trim() !== "";
const norm = (v) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

async function main() {
  if (apply && !backupPath) {
    throw new Error("--apply exige --backup <archivo.json>");
  }

  const info = await client.execute("PRAGMA table_info(plastic_products)");
  const hasColumn = info.rows.some((row) => row.name === "es_insumo");

  const piezas = (
    await client.execute(
      `SELECT id, nombre, sku, ${TEXT_COLUMNS.join(", ")}, (imagen IS NOT NULL) AS tiene_imagen,
              creado_en, actualizado_en
       FROM plastic_products WHERE sku GLOB 'INS-[0-9][0-9][0-9][0-9]' ORDER BY sku, id`,
    )
  ).rows.map((r) => ({ ...r }));

  const grupos = new Map();
  for (const p of piezas) {
    if (!grupos.has(p.sku)) grupos.set(p.sku, []);
    grupos.get(p.sku).push(p);
  }

  const statements = [];
  const respaldo = { maestras: [], piezasBorradas: [], vinculosMovidos: [], vinculosBorrados: [], lotes: [] };
  const lotes = (
    await client.execute("SELECT id, plastic_product_ids FROM piezas_import_batches WHERE deshecho_en IS NULL")
  ).rows.map((r) => ({ id: Number(r.id), ids: JSON.parse(String(r.plastic_product_ids)) }));

  console.log(`Piezas con SKU INS-NNNN: ${piezas.length} en ${grupos.size} SKU distintos.`);

  for (const [sku, grupo] of grupos) {
    if (grupo.length === 1) {
      console.log(`  ${sku}: única (${grupo[0].id}) — nada que unificar.`);
      continue;
    }
    const nombres = new Set(grupo.map((p) => norm(p.nombre)));
    if (nombres.size > 1) {
      console.log(`  ${sku}: ${grupo.length} copias con NOMBRES DISTINTOS (${[...nombres].join(" | ")}) — se omite, revisar a mano.`);
      continue;
    }
    if (grupo.some((p) => Number(p.tiene_imagen) === 1)) {
      console.log(`  ${sku}: alguna copia tiene imagen — se omite, revisar a mano.`);
      continue;
    }
    const score = (p) => TEXT_COLUMNS.filter((c) => filled(p[c])).length;
    const maestra = [...grupo].sort((a, b) => score(b) - score(a) || Number(a.id) - Number(b.id))[0];
    const copias = grupo.filter((p) => p.id !== maestra.id);

    const relleno = {};
    const conflictos = [];
    for (const col of TEXT_COLUMNS) {
      if (filled(maestra[col])) {
        for (const c of copias) {
          if (filled(c[col]) && norm(c[col]) !== norm(maestra[col])) conflictos.push(`${col}: "${maestra[col]}" vs "${c[col]}" (id ${c.id})`);
        }
        continue;
      }
      const donante = copias.find((c) => filled(c[col]));
      if (donante) relleno[col] = donante[col];
    }

    const ids = copias.map((c) => Number(c.id));
    const placeholders = ids.map((_, i) => `?${i + 1}`).join(", ");
    const vinculos = (
      await client.execute({
        sql: `SELECT id, product_id, plastic_product_id, orden, cantidad FROM product_plastic_items WHERE plastic_product_id IN (${placeholders}) ORDER BY id`,
        args: ids,
      })
    ).rows.map((r) => ({ ...r }));
    const yaEnMaestra = new Set(
      (
        await client.execute({
          sql: "SELECT product_id FROM product_plastic_items WHERE plastic_product_id = ?1",
          args: [Number(maestra.id)],
        })
      ).rows.map((r) => Number(r.product_id)),
    );

    let movidos = 0;
    let duplicados = 0;
    for (const v of vinculos) {
      if (yaEnMaestra.has(Number(v.product_id))) {
        statements.push({ sql: "DELETE FROM product_plastic_items WHERE id = ?1", args: [Number(v.id)] });
        respaldo.vinculosBorrados.push(v);
        duplicados += 1;
      } else {
        statements.push({
          sql: "UPDATE product_plastic_items SET plastic_product_id = ?1 WHERE id = ?2",
          args: [Number(maestra.id), Number(v.id)],
        });
        respaldo.vinculosMovidos.push(v);
        yaEnMaestra.add(Number(v.product_id));
        movidos += 1;
      }
    }

    const cols = Object.keys(relleno);
    if (cols.length > 0) {
      statements.push({
        sql: `UPDATE plastic_products SET ${cols.map((c, i) => `${c} = ?${i + 1}`).join(", ")} WHERE id = ?${cols.length + 1}`,
        args: [...cols.map((c) => relleno[c]), Number(maestra.id)],
      });
    }

    const sacarDeLotes = [...ids, Number(maestra.id)];
    for (const lote of lotes) {
      const quedan = lote.ids.filter((id) => !sacarDeLotes.includes(id));
      if (quedan.length !== lote.ids.length) {
        respaldo.lotes.push({ id: lote.id, plastic_product_ids: JSON.stringify(lote.ids) });
        statements.push({
          sql: "UPDATE piezas_import_batches SET plastic_product_ids = ?1, total = ?2 WHERE id = ?3",
          args: [JSON.stringify(quedan), quedan.length, lote.id],
        });
        lote.ids = quedan;
      }
    }

    statements.push({ sql: `DELETE FROM plastic_products WHERE id IN (${placeholders})`, args: ids });
    respaldo.piezasBorradas.push(...copias);
    respaldo.maestras.push(maestra);

    console.log(
      `  ${sku}: ${grupo.length} copias → maestra ${maestra.id}; ${copias.length} a borrar, ${movidos} vínculos reapuntados, ${duplicados} vínculos repetidos descartados` +
        (cols.length ? `, completa: ${cols.join(", ")}` : "") +
        (conflictos.length ? `, CONFLICTOS (se conserva la maestra): ${conflictos.join("; ")}` : ""),
    );
  }

  console.log(`Sentencias de unificación: ${statements.length}.`);
  if (!apply) {
    console.log(hasColumn ? "es_insumo ya existe." : "Se agregaría plastic_products.es_insumo.");
    console.log("SIMULACIÓN — no se escribió nada. Usá --apply --backup <archivo.json> para aplicar.");
    return;
  }

  writeFileSync(backupPath, JSON.stringify(respaldo, null, 2));
  console.log(`Respaldo escrito en ${backupPath}`);

  if (!hasColumn) {
    await client.execute("ALTER TABLE plastic_products ADD COLUMN es_insumo INTEGER NOT NULL DEFAULT 0");
    console.log("Columna plastic_products.es_insumo agregada.");
  }

  await client.batch(
    [
      ...statements,
      { sql: "UPDATE plastic_products SET es_insumo = 1 WHERE sku GLOB 'INS-[0-9][0-9][0-9][0-9]' AND es_insumo = 0", args: [] },
      { sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_plastic_products_insumo_sku ON plastic_products(sku) WHERE es_insumo = 1", args: [] },
    ],
    "write",
  );

  const resumen = (
    await client.execute(
      "SELECT sku, nombre, (SELECT COUNT(*) FROM product_plastic_items i WHERE i.plastic_product_id = p.id) AS fichas FROM plastic_products p WHERE es_insumo = 1 ORDER BY sku",
    )
  ).rows;
  console.log("Insumos tras la migración:");
  for (const r of resumen) console.log(`  ${r.sku}  ${r.nombre}  (${r.fichas} fichas)`);
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
