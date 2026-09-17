// One-off: genera la PRIMERA credencial de activación a mano, directo
// contra la base Turso de licenciamiento — necesario solo una vez, porque
// hay un problema de huevo-y-gallina: crear credenciales normalmente se
// hace desde Configuraciones → Instalaciones dentro de CLIO, pero esa
// pantalla exige una instalación ya activada Y una cuenta admin logueada.
// La primera instalación no tiene ninguna de las dos todavía. Este script
// hace exactamente lo mismo que createCredential() en
// update-api/src/logic/credentials.ts (mismo formato de código, mismo
// hash SHA-256 guardado, nunca el código en texto plano) pero insertando
// directo con INSTALLATIONS_TURSO_URL/TOKEN en vez de pasar por el Worker.
//
// Una vez que esa primera instalación esté activada y su usuario sea
// admin (o tenga instalaciones_crear_credenciales), TODAS las demás
// credenciales se generan desde la UI — no volver a correr este script
// salvo para otra primera activación de emergencia.
//
// Uso:
// node scripts/bootstrap-first-credential.mjs --sede-codigo=PUE --sede-nombre="Puebla" --descripcion="Equipo admin" --responsable="Tu nombre" --creado-por=bootstrap
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
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

function parseArgs() {
  const args = {};
  for (const raw of process.argv.slice(2)) {
    const match = raw.match(/^--([a-z-]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

// Mismo formato/entropía que generateActivationCode() en
// update-api/src/logic/crypto.ts — 256 bits, base32, "CLIO-XXXX-XXXX-...".
function generateActivationCode() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes = randomBytes(32);
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  const chunks = output.match(/.{1,4}/g) ?? [output];
  return `CLIO-${chunks.join("-")}`;
}

const env = loadEnv();
if (!env.INSTALLATIONS_TURSO_URL || !env.INSTALLATIONS_TURSO_TOKEN) {
  console.error(
    "Faltan INSTALLATIONS_TURSO_URL/INSTALLATIONS_TURSO_TOKEN en .env — correr primero scripts/create-installations-db-schema.mjs.",
  );
  process.exit(1);
}

const args = parseArgs();
const sedeCodigo = (args["sede-codigo"] ?? "").trim().toUpperCase();
const sedeNombre = (args["sede-nombre"] ?? "").trim();
const descripcion = (args["descripcion"] ?? "").trim();
const responsable = (args["responsable"] ?? "").trim();
const creadoPor = (args["creado-por"] ?? "bootstrap").trim();

if (!sedeCodigo || !sedeNombre) {
  console.error(
    'Faltan argumentos. Uso: node scripts/bootstrap-first-credential.mjs --sede-codigo=PUE --sede-nombre="Puebla" [--descripcion="..."] [--responsable="..."] [--creado-por=...]',
  );
  process.exit(1);
}

const client = createClient({
  url: env.INSTALLATIONS_TURSO_URL,
  authToken: env.INSTALLATIONS_TURSO_TOKEN,
});

async function main() {
  const codigo = generateActivationCode();
  const codeHash = createHash("sha256").update(codigo).digest("hex");
  const preview = codigo.slice(-4);

  await client.execute({
    sql: `INSERT INTO installation_credentials
            (code_hash, code_preview, sede_codigo, sede_nombre, descripcion, usuario_responsable, creado_por)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    args: [codeHash, preview, sedeCodigo, sedeNombre, descripcion, responsable || null, creadoPor],
  });

  console.log("Credencial creada. Este código no se vuelve a poder mostrar — cópialo ahora:\n");
  console.log(`  ${codigo}\n`);
  console.log(`Sede: ${sedeNombre} (${sedeCodigo})`);
  console.log("Úsalo en ActivationScreen en la primera máquina. Una vez activada y con un usuario");
  console.log("admin logueado, generá el resto de las credenciales desde Configuraciones → Instalaciones.");
}

main()
  .then(() => client.close())
  .catch((err) => {
    console.error(err);
    client.close();
    process.exitCode = 1;
  });
