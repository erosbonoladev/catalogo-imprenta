import { createClient, type Client } from "@libsql/client/web";
import type { Env } from "./env";

// Dos bases separadas a propósito (ver docs/DISTRIBUTION.md): esta base de
// licenciamiento (lectura/escritura) nunca es alcanzable con el token de
// Turso que va embebido en el bundle de CLIO. La base principal solo se
// toca en modo lectura, y solo para verificar sesión/rol admin
// (assertAdmin en logic/adminAuth.ts) — el Worker nunca escribe ahí.

export function licensingClient(env: Env): Client {
  return createClient({
    url: env.INSTALLATIONS_TURSO_URL,
    authToken: env.INSTALLATIONS_TURSO_TOKEN,
    intMode: "number",
  });
}

export function mainReadOnlyClient(env: Env): Client {
  return createClient({
    url: env.MAIN_TURSO_URL,
    authToken: env.MAIN_TURSO_TOKEN_RO,
    intMode: "number",
  });
}
