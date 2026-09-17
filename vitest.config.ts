import { defineConfig } from "vitest/config";

// Config de pruebas completamente separada de vite.config.ts: el alias de
// abajo solo debe existir bajo `vitest`, nunca filtrarse al build real de
// Tauri. `src/db.ts` importa específicamente "@libsql/client/web" (cliente
// solo-transporte HTTP/WebSocket, sin acceso a archivos locales — no
// soporta URLs "file:"). Para poder correr pruebas de integridad contra un
// SQLite/libSQL local y descartable (ver tests/setup.ts) sin tocar ese
// import de producción, se redirige únicamente aquí al cliente Node de
// @libsql/client, que sí habla SQLite local — implementan la misma interfaz
// de @libsql/core (execute/transaction/batch/migrate), así que db.ts corre
// sin cambios.
export default defineConfig({
  resolve: {
    alias: {
      "@libsql/client/web": "@libsql/client",
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    fileParallelism: false,
    // update-api/ es un paquete Node separado con su propio
    // vitest.config.ts/tests/setup.ts (esquema de dos bases distinto al de
    // acá) — sin este exclude, el glob por defecto de Vitest igual
    // encuentra sus *.test.ts y los corre contra el setup de la raíz,
    // fallando por "no such table". Correr sus pruebas con `npm test`
    // dentro de esa carpeta (ver docs/DISTRIBUTION.md).
    exclude: ["**/node_modules/**", "update-api/**"],
  },
});
