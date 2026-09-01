# Arquitectura

## Stack

Tauri v2 (Rust shell + webview OS) + React 19 + TypeScript. DB: Turso (libSQL hosteado) vía `@libsql/client/web` — HTTPS/WebSocket puro, sin plugin de Tauri. Elegido sobre Electron por tamaño de instalador. PDF: `jspdf`. Import Excel: `xlsx` (tarball de SheetJS, no el paquete de npm registry).

## Capa de datos

Todo pasa por `src/db.ts` (único archivo que importa `@libsql/client`). Cliente único a nivel de módulo desde `VITE_TURSO_URL`/`VITE_TURSO_AUTH_TOKEN`. Sin fallback local — sin internet no hay DB, punto. Ver [DATABASE.md](DATABASE.md) para esquema y funciones.

## Navegación

Sin router. `App.tsx` primero revisa `useAuth()` (`user`/`loading`); sin sesión válida renderiza `LoginScreen` y bloquea todo lo demás. Con sesión, un `useState<View>` intercambia componentes — `View` es una unión discriminada con payload (`{name: "detail", productId}`, etc.), no strings sueltos. No introducir `react-router` sin una razón de peso.

El **Sidebar no es un menú de navegación** — es chrome persistente (colapsar, usuario, toggle de tema, atajo a Remisiones gateado, logout, engranaje de Configuraciones gateado, `UpdateChecker`). Las transiciones entre pantallas siguen siendo props/callbacks (`onSelect`, `onBack`, `onOpenImprenta`, `onRemisiones`, `onConfiguraciones`, etc.) de cada pantalla — el Sidebar solo tiene dos "atajos" especiales (Remisiones y Configuraciones) que llaman de vuelta a `App.tsx`, no una lista general de destinos. El de Remisiones es una fila con ícono+texto (`Assets/remisiones.svg`) justo debajo del toggle de tema, separada por `.sidebar-divider`; el de Configuraciones sigue siendo el ícono cuadrado solo en `.sidebar-bottom-group` — no es el mismo patrón visual para los dos, a propósito (el usuario pidió esa ubicación específicamente para Remisiones).

## Imágenes

BLOB en la DB (`imagen`+`imagen_mime`), no archivos locales — así se ven igual en toda máquina. `pickImage()` lee bytes con `@tauri-apps/plugin-fs` → `{data: Uint8Array, mime}` en memoria hasta guardar → va directo al INSERT/UPDATE como parámetro BLOB. Para mostrar: `getImageSrc()` arma un `Blob` y devuelve `URL.createObjectURL(...)` (no `convertFileSrc`/asset protocol). Leer un archivo fuera del sandbox de la app requiere `fs:allow-home-read-recursive`; guardar un PDF donde sea bajo `$HOME` requiere `fs:allow-home-write-recursive`.

## Convención de pantallas editables

Toda pantalla editable (`ProductForm`, `PlasticosSection`, `ImprentaSection`, `UsersPanel`, etc.) usa: estado `dirty` (true en cada cambio de campo, false tras guardar) → `disabled={saving || !dirty}` en el botón primario (gris cuando no hay nada que guardar). Éxito → `Toast.tsx` ("Guardado con éxito", ~2.5s), excepto `ProductForm` que navega fuera inmediatamente y usaría `onDone`. Texto libre → `AutoGrowInput.tsx` (textarea que crece), excepto `tipo_papel` en Imprenta (input real, necesita `list=` datalist). Mantener este patrón en pantallas nuevas.

## Rust / capabilities

Comandos (`src-tauri/src/lib.rs`): solo `hash_password`/`verify_password` (bcrypt puro). Plugins: `dialog`, `fs`, `opener`, `updater`, `process`. Comandos custom (`#[tauri::command]`) no necesitan entrada en capabilities; los permisos de plugin sí (`src-tauri/capabilities/default.json`).

**Gotcha recurrente**: `<plugin>:default` casi nunca cubre todo lo que el plugin puede hacer — es el subconjunto "seguro". El permiso real hay que buscarlo en el `permissions/default.toml` propio del crate (fuente en crates.io / `~/.cargo/registry/src/`). Ya pasó dos veces: `sql:default` no traía `allow-execute` (solo lectura funcionaba); `fs:default` no cubre archivos fuera del sandbox de la app. Cambios de capability requieren rebuild completo (matar y reiniciar `tauri dev`), no alcanza con HMR.

**Otro gotcha, distinto**: si `npm run tauri dev` falla en la compilación de Rust con algo como `failed to read plugin permissions: ... No such file or directory` apuntando a una ruta que **no** coincide con la carpeta real del proyecto (ej. le falta un segmento del path), es caché de `src-tauri/target` con rutas absolutas viejas — pasa si el proyecto se movió/renombró de carpeta en algún momento. No es un bug de código: `cd src-tauri && cargo clean` (borra el `target/` regenerable, no toca nada versionado) y volver a correr `npm run tauri dev` — la primera compilación después de esto tarda varios minutos (recompila todo el árbol de dependencias de Tauri desde cero), las siguientes vuelven a ser incrementales.

## Backups

Los backups disparados desde la propia app (manual, pre-importación, pre-restauración) se guardan localmente bajo `appDataDir()/backups` — ya cubierto por `fs:allow-home-*-recursive`, sin tocar capabilities. El backup automático programado corre en un **repositorio de GitHub separado y privado** (`erosbonoladev/clio-backups`, no este repo), con su propio workflow `schedule:` horario que lee la configuración desde la tabla `backup_settings` en Turso (no un cron fijo) y publica los archivos como GitHub Releases de ese repo. Detalle completo, incluyendo por qué está separado así y las credenciales que usa: [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md).

## Empaquetado

Build local = solo el instalador del SO anfitrión. Ambas plataformas se compilan por GitHub Actions (`.github/workflows/build.yml`, disparado por `gh workflow run build.yml` o un tag `app-v*`), produce un GitHub Release en draft con `.dmg`/`.exe`/`.msi`. Firma de macOS necesita los secrets `APPLE_*` en el repo (sin ellos, build sin firmar — instalar local con Control-click→Open o `xattr -cr`). Windows sin certificado de firma. El workflow necesita `VITE_TURSO_URL`/`VITE_TURSO_AUTH_TOKEN` como repo secrets (mismos valores que `.env` local).

## Constraints aceptados (no son descuidos)

- Token de Turso embebido en el bundle en build time — sin backend no hay dónde más guardarlo. Mitigación: token scopeado a una sola DB, rotable desde el dashboard de Turso. No intentar "ocultarlo mejor" en el bundle — es teatro de seguridad para una app de escritorio; una solución real sería un backend intermediario, que es un cambio de arquitectura, no un parche.
- Sin modo offline.
- Escrituras concurrentes: last-write-wins, sin manejo especial.
- Catálogo base abierto a todo usuario activo — a propósito, no es un permiso faltante.
- "Usuarios conectados" es aproximado (heartbeat, no presencia real) — ver [WORKFLOWS.md](WORKFLOWS.md#heartbeat-de-usuarios-conectados).
- `app_logs` crece sin límite automático (sí existe `clearLogs()` manual).
- Sin optimización/resize de imágenes al importar.
