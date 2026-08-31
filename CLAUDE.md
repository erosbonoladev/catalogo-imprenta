# CLAUDE.md

Guía para Claude Code en este repo. Esto es un **índice**: reglas siempre vigentes + comandos. El detalle de esquema/flujos/permisos vive en `docs/` — leer solo el archivo que aplique a la tarea (tabla al final).

## Qué es

Catálogo de escritorio para una imprenta industrial. Login individual → catálogo base (ficha técnica: imagen, material, categoría, descripción, specs) abierto a todo usuario autenticado. Tres secciones internas permission-gated (Piezas, Imprenta, Configuraciones) más Requisiciones. Corre en Windows y macOS contra una BD cloud compartida (Turso). Estado real de cada módulo: [docs/MODULES.md](docs/MODULES.md) — no asumir que algo existe sin confirmarlo ahí o en el código.

## Stack

Tauri v2 (Rust + webview) + React 19 + TypeScript. BD: Turso/libSQL vía `@libsql/client/web` (sin plugin de Tauri, sin fallback local). PDF: `jspdf`. Import Excel: `xlsx`. Sin suite de tests.

## Comandos

Node/Rust vía `nvm`/`rustup`; si una shell nueva no los encuentra: `source ~/.zshrc` o cargar `nvm.sh`/`cargo/env` manualmente.

Requiere `.env` en la raíz (gitignored) con `VITE_TURSO_URL`, `VITE_TURSO_AUTH_TOKEN`, `VITE_WHATSAPP_BODEGA_NUMBER` — ver `.env.example`. Se hornean en el bundle JS en build time. Sin `.env` la app compila pero toda llamada a DB falla en runtime.

- `npm run tauri dev` — app completa (Rust+webview), la forma normal de probar cambios.
- `npm run dev` — solo Vite/frontend en navegador; `db.ts` funciona (fetch/WebSocket), pero `invoke` (hash/verify password) y los plugins dialog/fs (imágenes) no. Sirve para iterar UI de búsqueda/detalle/specs, no para login ni secciones gateadas.
- `npx tsc --noEmit` — type-check.
- `npm run build` — type-check + build de producción (`dist/`).
- `cd src-tauri && cargo check` — chequeo rápido de Rust.

Empaquetado (GitHub Actions, secrets, firma): [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#empaquetado). Repo: `github.com/erosbonoladev/catalogo-imprenta`.

## Reglas SIEMPRE vigentes

- Toda query nueva va en `src/db.ts`, nunca inline en un componente — es la única puerta a la BD.
- Sin router: la navegación es un `useState<View>` en `App.tsx`. No introducir `react-router` sin razón de peso.
- Toda pantalla gateada (`hasPermission`/`isAdmin`) chequea en su propio render, no solo ocultando el botón de entrada. Ver [docs/PERMISSIONS.md](docs/PERMISSIONS.md).
- Fichas técnicas (catálogo base) no lleva gate de permiso — es intencional, no un hueco.
- Pantallas editables siguen el patrón `dirty`/botón gris/`Toast`/`AutoGrowInput` — ver [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- No resucitar tablas/columnas/dependencias marcadas como muertas en [docs/DATABASE.md](docs/DATABASE.md) sin confirmar con el usuario primero.
- Cambiar una capability de Tauri: el `<plugin>:default` casi nunca alcanza — revisar `permissions/default.toml` del crate. Requiere rebuild completo, no HMR. Detalle: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#rust--capabilities).
- `LogsPanel` es de solo lectura — nunca darle capacidad de ejecutar nada.
- No "arreglar" el token de Turso embebido en el bundle escondiéndolo distinto — es un constraint aceptado, ver [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#constraints-aceptados-no-son-descuidos).
- Toda importación masiva (fichas, imágenes, y cualquier futura) debe crear un backup previo (`runBackupNow`) antes de escribir — si falla, la importación no arranca. No quitar ese hook ni "optimizarlo" saltándoselo.
- El repo `erosbonoladev/clio-backups` (separado de este) corre el backup automático programado — no es un repo huérfano ni un fork accidental. Ver [docs/DISASTER_RECOVERY.md](docs/DISASTER_RECOVERY.md).

## Convenciones de código

- Sin comentarios salvo que el *por qué* no sea obvio.
- No agregar abstracciones/validaciones para casos que no pueden pasar.

## Documentación adicional — leer solo cuando la tarea lo requiera

| Tarea | Leer |
|---|---|
| Esquema, tablas, columnas, queries de `db.ts` | [docs/DATABASE.md](docs/DATABASE.md) |
| Usuarios, roles, `hasPermission`/`isAdmin`, sesión/login | [docs/PERMISSIONS.md](docs/PERMISSIONS.md) |
| Arquitectura general, imágenes, navegación, Rust/capabilities, empaquetado | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Qué existe y en qué estado (antes de decir "esto ya está" o "esto falta") | [docs/MODULES.md](docs/MODULES.md) |
| Flujo completo de Requisiciones, Folios, Producción/Compra, importación Excel/imágenes, PDF | [docs/WORKFLOWS.md](docs/WORKFLOWS.md) |
| Backups, restauración, recuperación ante fallas | [docs/DISASTER_RECOVERY.md](docs/DISASTER_RECOVERY.md) |

App: `com.mariat.catalogo-imprenta` / "Clio".
