# Distribución, activación de instalaciones y auto-update

CLIO se distribuye entre sedes vía GitHub Releases privados. Como no debe haber ningún Personal Access Token (PAT) de GitHub dentro del ejecutable, ni credenciales administrativas de Turso, existe un servicio intermedio — el **Update API** (`update-api/`, un Cloudflare Worker) — que autoriza instalaciones y sirve las actualizaciones sin exponer secretos al cliente.

## Arquitectura

```
CLIO (Tauri)                    Update API (Cloudflare Worker)         GitHub privado
─────────────                   ──────────────────────────────         ───────────────
ActivationScreen/                POST /installations/activate           GET /releases/latest
ActivationProvider   ──HTTPS──►  POST /installations/status     ──►     GET /releases/assets/:id
(keychain: installation_id +     GET  /updates/latest                  (con GITHUB_TOKEN, nunca
 device_token, vía keyring-rs)   GET  /updates/download/:asset          en el cliente)

InstalacionesPanel                POST /admin/credentials
(Configuraciones, admin)  ──►     GET  /admin/installations
 pasa {actorId, actorToken}       POST /admin/installations/:id/revoke
 (mismo Actor que db.ts)          POST /admin/installations/:id/reactivate
                                   POST /admin/credentials/:id/regenerate

                                   assertActorAuthorized() lee la base Turso
                                   PRINCIPAL en modo solo-lectura (verifica
                                   sesión + permiso/rol admin, espejo de
                                   src/db.ts) — nunca escribe ahí.

                                   Lee/escribe installations/credentials/
                                   audit_logs en una base Turso SEPARADA
                                   ("de licenciamiento") — el token embebido
                                   en el bundle de CLIO nunca alcanza esta base.
```

Por qué una base Turso separada (no solo tablas nuevas en la principal): el token de Turso que va horneado en el bundle de CLIO (constraint aceptado, ver [ARCHITECTURE.md](ARCHITECTURE.md#constraints-aceptados-no-son-descuidos)) da acceso de lectura/escritura a *todo* lo que viva en esa base. Si `installation_credentials` estuviera ahí, cualquiera con devtools y ese token podría leer/fabricar credenciales de activación — exactamente lo que este sistema existe para evitar. Con una base separada, solo el Worker tiene el token de esa base; CLIO nunca se conecta a ella directamente.

## Componentes en el repo

| Componente | Dónde |
|---|---|
| Worker (Update API) | `update-api/` — TypeScript, sin framework, lógica de negocio en `update-api/src/logic/*.ts` separada del router HTTP (`update-api/src/index.ts`) para poder testearla con Vitest normal |
| Esquema de la base de licenciamiento | `scripts/create-installations-db-schema.mjs` (one-off, mismo patrón que el resto de `scripts/*.mjs` — ver [DATABASE.md](DATABASE.md)) |
| Credencial local del dispositivo | `src-tauri/src/lib.rs` (`store_device_credential`/`load_device_credential`/`clear_device_credential`, vía `keyring` crate → Keychain en macOS, Credential Manager en Windows) |
| Cliente del Update API | `src/activation.ts` (única puerta al Worker, mismo criterio que `src/db.ts` con Turso) |
| Gate de instalación | `src/activationContext.tsx` (`ActivationProvider`) + `src/components/ActivationScreen.tsx`, montados en `src/main.tsx` por fuera de `AuthProvider` — es un gate de *máquina*, previo al login de usuario |
| Administración | `src/components/InstalacionesPanel.tsx`, tab "Instalaciones" dentro de Configuraciones (ver [PERMISSIONS.md](PERMISSIONS.md)) |

## Variables de entorno

**Cliente (`.env` raíz, horneadas en el bundle — ver `.env.example`):**

- `VITE_UPDATE_API_URL` — URL del Worker desplegado. No es secreta (como `VITE_TURSO_URL`, conocer la URL no da acceso a nada sin una credencial de instalación válida).
- `INSTALLATIONS_TURSO_URL`/`INSTALLATIONS_TURSO_TOKEN` — **no llevan prefijo `VITE_` a propósito**, así Vite nunca los expone al bundle. Solo se usan localmente para correr `scripts/create-installations-db-schema.mjs`. No son las credenciales que usa el Worker en producción (esas son secrets de Cloudflare, ver abajo).

**Worker (`update-api/wrangler.toml` para valores no secretos; secrets reales con `wrangler secret put`, nunca en el repo):**

| Secret | Qué es | Alcance |
|---|---|---|
| `GITHUB_TOKEN` | PAT fine-grained | Solo `contents: read` sobre `erosbonoladev/catalogo-imprenta`, ningún otro permiso |
| `INSTALLATIONS_TURSO_URL` / `INSTALLATIONS_TURSO_TOKEN` | Base de licenciamiento | Lectura/escritura completa — solo el Worker la tiene |
| `MAIN_TURSO_URL` / `MAIN_TURSO_TOKEN_RO` | Base principal (la misma que usa CLIO) | **Solo lectura** — el Worker nunca escribe ahí, solo verifica sesión/permiso admin (`assertActorAuthorized`, espejo de la función homónima en `src/db.ts`) |
| `DOWNLOAD_TOKEN_SECRET` | Secreto HMAC propio | Firma los tokens de descarga de corta duración (10 min) que van embebidos en las URLs de `latest.json` |

`GITHUB_OWNER`/`GITHUB_REPO` son valores no secretos, en `[vars]` de `wrangler.toml`.

## Cómo crear el PAT de GitHub

GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token. Repository access: solo `erosbonoladev/catalogo-imprenta`. Permissions: **Contents: Read-only**, nada más (no `write`, no `admin`). Expiración: la más larga disponible o "no expira" con rotación manual periódica documentada aparte — es el único secreto de todo el sistema con acceso de lectura al código fuente privado, tratarlo en consecuencia.

## Cómo configurar el Worker

```bash
cd update-api
npm install
wrangler login
wrangler secret put GITHUB_TOKEN
wrangler secret put INSTALLATIONS_TURSO_URL
wrangler secret put INSTALLATIONS_TURSO_TOKEN
wrangler secret put MAIN_TURSO_URL
wrangler secret put MAIN_TURSO_TOKEN_RO
wrangler secret put DOWNLOAD_TOKEN_SECRET   # cualquier string largo/random, ej: openssl rand -hex 32
wrangler deploy
```

Para desarrollo local: copiar `update-api/.dev.vars.example` a `update-api/.dev.vars` (gitignored) con credenciales de **staging** (nunca las de producción — ver "Desarrollo local" abajo), y correr `npm run dev` (usa `wrangler dev`).

Después de desplegar, actualizar tres lugares con la URL real (`https://clio-update-api.<subdominio>.workers.dev`, o el dominio custom que se configure):
1. `src-tauri/tauri.conf.json` → `plugins.updater.endpoints` (hoy tiene un placeholder `WORKERS_SUBDOMAIN`).
2. `src-tauri/capabilities/default.json` → el patrón en `http:default.allow` (hoy `https://clio-update-api.*.workers.dev/*`; si se usa un dominio custom, cambiarlo ahí también).
3. `.env` → `VITE_UPDATE_API_URL`.

Cambiar `tauri.conf.json`/`capabilities` requiere rebuild completo (no HMR), mismo gotcha ya documentado en [ARCHITECTURE.md](ARCHITECTURE.md#rust--capabilities).

## Firmas del updater

Sin cambios respecto al sistema ya existente: `TAURI_SIGNING_PRIVATE_KEY`/`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (secrets del repo de GitHub, usados por `.github/workflows/build.yml` vía `tauri-action`) siguen firmando cada release con minisign, y `pubkey` en `tauri.conf.json` sigue siendo la misma — el Worker no toca la firma en absoluto, solo reescribe las URLs de descarga dentro del `latest.json` que ya viene firmado. Un `latest.json`/binario con firma inválida sigue siendo rechazado por el propio plugin updater de Tauri, antes de instalar nada.

La clave privada de firma nunca estuvo ni debe estar en el repo ni en CLIO — sigue siendo un secret de GitHub Actions exclusivamente.

## Sistema de credenciales y activación

**La primera credencial es un caso especial (huevo-y-gallina)**: crear credenciales normalmente se hace desde Configuraciones → Instalaciones dentro de CLIO, pero esa pantalla exige una instalación ya activada *y* una cuenta admin logueada — la primerísima instalación no tiene ninguna de las dos. Para esa única vez: `node scripts/bootstrap-first-credential.mjs --sede-codigo=PUE --sede-nombre="Puebla" --descripcion="Equipo admin" --responsable="Tu nombre"` (lee `INSTALLATIONS_TURSO_URL`/`INSTALLATIONS_TURSO_TOKEN` del `.env` local, inserta directo en la base de licenciamiento, mismo formato/hash que `createCredential()` en el Worker). Activá esa primera máquina con el código que imprime, entrá con una cuenta admin de CLIO, y desde ahí generá todas las demás credenciales normalmente desde la UI.

Ver el esquema completo en [DATABASE.md](DATABASE.md#instalaciones--credenciales-de-activación-base-separada). Resumen del flujo (después de la primera, vía UI):

1. Un admin de CLIO crea una credencial desde Configuraciones → Instalaciones → "Crear credencial" (sede, nombre, responsable). El Worker genera un código de 256 bits de entropía (formato `CLIO-XXXX-XXXX-...`), guarda solo su hash SHA-256, y devuelve el código en texto plano **una sola vez** — no se puede volver a mostrar completo después (solo sus últimos 4 caracteres, para reconocerla en la lista).
2. Ese código se entrega a la sede por el canal que ya use el negocio (no es responsabilidad de CLIO transportarlo).
3. En la instalación nueva, `ActivationScreen` pide el código y llama `POST /installations/activate`. El Worker valida el hash, genera un `installation_id` consecutivo por sede (`CLIO-PUE-0001`, mismo truco de `MAX+1` en subquery que usa `insertFolioRow` en `src/db.ts`) y un device token de 256 bits, y marca la credencial como usada (no se puede reutilizar).
4. El device token se guarda en el Keychain/Credential Manager nativo (`store_device_credential`), nunca en `localStorage` ni en un archivo plano.

**Sin rate-limiting artificial** en `/installations/activate`: la entropía del código (256 bits) hace la fuerza bruta computacionalmente inviable. Cada intento fallido se audita en `audit_logs` (`activation_failed`) para visibilidad, no para bloquear.

## Revocación y reactivación

Desde Configuraciones → Instalaciones, con los permisos `instalaciones_revocar`/`instalaciones_reactivar` (o rol admin — ver [PERMISSIONS.md](PERMISSIONS.md)). Una instalación revocada:

- No puede obtener un `latest.json` nuevo (`/updates/latest` responde 403).
- El heartbeat (`/installations/status`) responde `authorized: false, estado: "revocada"`.
- **No se borra nada local** — ni la fila en la base de licenciamiento, ni la credencial en el Keychain del cliente. Reactivar (mismo botón, invertido) vuelve a autorizarla sin que la sede tenga que reinstalar ni reactivar con un código nuevo.

## Ventana de gracia offline

Decisión: **7 días** desde la última verificación exitosa contra el Worker (`GRACE_PERIOD_MS` en `src/activationContext.tsx`). Si no hay red, la app sigue funcionando hasta ese límite; pasado ese punto sin poder validar, bloquea con un mensaje explícito pidiendo conexión — nunca deja una instalación potencialmente revocada autorizada para siempre solo porque perdió internet. Si el servidor sí responde y dice explícitamente "revocada", el bloqueo es inmediato, sin esperar la ventana. `ActivationProvider` reintenta la verificación cada 30 minutos mientras la app está abierta (además del chequeo al arrancar), así una revocación se refleja sin esperar a que reinicien CLIO.

Por qué 7 días y no menos: una sede sin internet por un fin de semana largo o un corte de proveedor no debe quedar sin poder facturar/consultar el catálogo. Por qué no más: una instalación revocada (ej. equipo robado, sede cerrada) no debe seguir operando indefinidamente sin que el sistema intente reconfirmar.

## Desarrollo local / staging / producción

- **Desarrollo del Worker**: `update-api/.dev.vars` con credenciales de una base Turso de *staging* separada (nunca apuntar a producción desde `wrangler dev`) y, si se necesita probar la parte de GitHub, un PAT fine-grained aparte con el mismo scope mínimo. Mismo criterio que la sección de staging ya documentada para `clio-backups` en [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md).
- **Pruebas del Worker**: `cd update-api && npm test` — Vitest contra dos bases SQLite locales descartables (`.tmp/test-licensing.db`, `.tmp/test-main.db`), nunca contra Turso real. Ver `update-api/tests/setup.ts`.
- **Producción**: `wrangler deploy` desde una máquina con los secrets reales configurados (`wrangler secret put`, una vez). El Worker en sí no tiene "ambientes" Vitest-style — es un solo deploy que sirve a todas las sedes.

## Checklist para publicar una versión nueva

1. Cambiar la versión en `package.json`, `src-tauri/Cargo.toml` y `src-tauri/tauri.conf.json` (las tres, como ya se hacía antes de este sistema).
2. `npm run build` (o dejar que lo haga `tauri-action` en CI) — el build ya incluye `VITE_UPDATE_API_URL`.
3. `git tag app-v<version> && git push origin app-v<version>` (o `gh workflow run build.yml`) — dispara `.github/workflows/build.yml`, que compila, firma (minisign) y publica un GitHub Release en draft con los instaladores + `latest.json`.
4. Publicar el release (sacarlo de draft) cuando esté listo.
5. Verificar el Update API: `curl -H "Authorization: Bearer <deviceToken de prueba>" -H "X-Installation-Id: <id>" https://<worker>/updates/latest` debería devolver el manifiesto reescrito (o 204 si por algún motivo el asset `latest.json` todavía no está en el release).
6. Probar la actualización desde una instalación de prueba activada (no producción): botón de actualizar en el Sidebar, confirmar que descarga, instala y relanza correctamente.
7. Confirmar que una instalación revocada de prueba recibe 403 en `/updates/latest` en vez de la actualización.

## Riesgo conocido: secuencia de migración desde el sistema anterior

El repo **no debe pasarse a privado hasta que las instalaciones existentes ya estén en una versión con este sistema activo** — los clientes ya instalados antes de este cambio (v0.15.0 y anteriores) tienen el endpoint viejo (`github.com/erosbonoladev/catalogo-imprenta/releases/latest/download/latest.json`) horneado en su binario, y ese endpoint solo responde si el repo sigue público. Orden obligatorio:

1. Desplegar el Worker y crear la base de licenciamiento (secciones de arriba), con el repo todavía **público**.
2. Generar credenciales de activación para cada sede existente desde Instalaciones (necesita al menos una máquina admin ya corriendo la build nueva).
3. Publicar la primera versión de CLIO con `ActivationProvider` + endpoint del Worker como release normal — el repo sigue público en este paso, así los clientes viejos se actualizan solos vía el mecanismo anterior.
4. Distribuir las credenciales a cada sede (por el canal que ya use el negocio) antes de o inmediatamente después de que reciban esa actualización — si la reciben sin tener el código a mano, van a quedar en `ActivationScreen` bloqueados hasta que un admin se los dé; coordinar el rollout (ej. ventana de mantenimiento) en vez de soltarlo sin aviso.
5. Confirmar que las sedes activaron esa versión.
6. Recién entonces pasar el repo a privado. De ahí en adelante todo update pasa por el Worker.
