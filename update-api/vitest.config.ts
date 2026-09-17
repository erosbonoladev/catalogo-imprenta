import { defineConfig } from "vitest/config";

// Mismo truco que el vitest.config.ts de la raíz del repo: el código de
// este Worker importa "@libsql/client/web" (compatible con el runtime de
// Cloudflare Workers en producción), pero para correr las pruebas contra
// un SQLite local descartable se redirige solo acá al cliente Node de
// @libsql/client — misma interfaz, sin tocar el import de producción.
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
  },
});
