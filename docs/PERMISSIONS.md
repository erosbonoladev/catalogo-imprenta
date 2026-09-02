# Permisos y autenticación

Fuente de verdad: `src/auth.tsx` + `PERMISOS`/`PERMISO_LABELS` en `src/types.ts`.

## Permisos actuales

```ts
PERMISOS = [
  "plasticos", "imprenta", "configuraciones", "requisiciones",
  "backups_ver", "backups_crear", "backups_descargar", "backups_restaurar",
  "backups_configurar", "backups_eliminar",
  "precios_ver", "precios_modificar",
  "remisiones_acceso", "remisiones_crear", "remisiones_cancelar",
]
```

| Valor interno | Etiqueta UI | Gatea |
|---|---|---|
| `plasticos` | **Piezas** | `PlasticosSection` |
| `imprenta` | Imprenta | `ImprentaSection` (incluye historial de órdenes) |
| `configuraciones` | Configuraciones | `Configuraciones` (tabs Usuarios/Conectados/Registro/Captura masiva) |
| `requisiciones` | Requisiciones | Botón "Requisición" por spec en `ProductDetail` |
| `backups_ver` | Backups: ver | Ver el tab "Backups" dentro de Configuraciones y su historial; también gatea los botones "Lista de precios" e "Historial de remisiones" (viven ahí por pedido del negocio, no porque sean parte del sistema de backups) |
| `backups_crear` | Backups: crear manual | Botón "Crear backup ahora" en `BackupsPanel` |
| `backups_descargar` | Backups: descargar | Botón "Descargar"/"Ver en GitHub" por fila del historial |
| `backups_restaurar` | Backups: restaurar | "Subir archivo de restauración" y "Restaurar" desde historial — cubre ambas vías, no hay un permiso separado para "subir archivo" (mismo riesgo, mismo gate) |
| `backups_configurar` | Backups: configurar programación | Sección "Programación" en `BackupsPanel` |
| `backups_eliminar` | Backups: eliminar | Botón "Eliminar" por fila del historial |
| `precios_ver` | Precios: ver | Botón "Precios" en `ProductDetail` y apertura de `PreciosModal` |
| `precios_modificar` | Precios: modificar | Dentro de `PreciosModal`: si falta, la tabla es de solo lectura (sin inputs editables ni botón "Guardar") |
| `remisiones_acceso` | Remisiones: acceso | Botón "Remisiones" en `Sidebar` (fila ícono+texto debajo de "Modo oscuro", separada por un divisor) + `RemisionesSection` (re-chequea al entrar) |
| `remisiones_crear` | Remisiones: crear | Muestra/oculta `RemisionForm` dentro de `RemisionesSection` |
| `remisiones_cancelar` | Remisiones: cancelar | Botón "Cancelar" por fila en la lista de remisiones recientes |

El string interno `plasticos` no cambió (ni el nombre de tabla `plastic_products`) aunque la UI diga "Piezas" — no renombrar uno sin el otro.

Fichas técnicas (catálogo base) **no tiene gate**: cualquier usuario autenticado y activo entra.

**`Configuraciones` tiene una excepción al patrón de un solo gate**: el tab "Backups" y el ícono de engranaje en `Sidebar` se muestran si el usuario tiene `configuraciones` **o** cualquiera de los 6 permisos `backups_*` (`PERMISOS_BACKUPS` en `types.ts`) — así alguien puede tener, por ejemplo, solo `backups_crear` sin necesitar el permiso general `configuraciones`, tal como pide la ficha de negocio de Backups ("otorgar permisos individualmente"). Ver `Configuraciones.tsx`/`Sidebar.tsx`.

## Dos mecanismos de gate, no confundirlos

- **`hasPermission(user, permiso)`** (`auth.tsx`): `false` si no hay usuario o está inactivo; `true` si `user.rol === "admin"` (acceso total, sin filas en `user_permissions`); si no, revisa `user.permisos.includes(permiso)`. Es el único mecanismo para los 4 permisos de la tabla de arriba.
- **`isAdmin(user)`** (`auth.tsx`): gate independiente, más estricto, para pantallas que **no son otorgables como permiso normal** — son exclusivas del rol admin: `FichaImportPanel`, `ImageImportPanel`, `PreciosImportPanel` (los tres sub-paneles de la pestaña "Captura masiva" en `Configuraciones`, ver `CapturaMasivaPanel.tsx`) y `UsersPanel` (pestaña "Usuarios"). Esta última quedó fuera del permiso general `configuraciones` a propósito: administrar usuarios implica poder otorgarse cualquier permiso o rol admin, así que no debe depender del mismo permiso que solo da acceso a Logs/Conectados.

Regla: todo screen gateado debe llamar a `hasPermission`/`isAdmin` **en su propio render**, no confiar solo en que el botón de entrada esté oculto (`PlasticosSection`, `ImprentaSection`, `Configuraciones` renderizan "Acceso denegado" si falla el check).

## Sesión

- Login (`LoginScreen` → `useAuth().login` → `verifyLogin()` en `db.ts`) usa el comando Rust `verify_password` (bcrypt). Retorna `ok | invalid | locked`.
- **Bloqueo de cuenta**: 5 intentos fallidos → bloqueo de 15 min (`users.failed_attempts`/`locked_until`).
- **Sesión por token con vencimiento deslizante**: al loguear se genera `session_token` (columna en `users`, 256 bits vía `crypto.getRandomValues`) y se fija `session_expires_at` a `SESSION_TTL_HOURS` (12h) adelante; solo `{id, token}` se guarda en `localStorage`, nunca el vencimiento ni nada más sensible. Al iniciar la app, `validateSession(id, token)` revalida contra la BD (rechaza si el token no coincide, el usuario está inactivo, o `session_expires_at` ya pasó) — nunca se confía en el `localStorage` cacheado. Cada `validateSession()` exitoso corre el vencimiento otras 12h (sesión deslizante: uso activo no expira a medias, un token abandonado sí). Cambiar la contraseña de un usuario anula su `session_token`/`session_expires_at` (fuerza logout en otras sesiones).
- **Revalidación periódica**: mientras la app está abierta, `AuthProvider` llama a `validateSession()` cada 5 minutos (no solo el heartbeat de presencia, que es otro mecanismo — ver [ARCHITECTURE.md](ARCHITECTURE.md)) y fuerza logout local si la BD la rechaza. Así, desactivar una cuenta desde `UsersPanel` (o que expire por inactividad) surte efecto en una sesión ya abierta sin esperar a que la cierren y reabran — es el mecanismo real para "invalidar una sesión" hoy; no hay un botón dedicado de "cerrar sesión de otro usuario", desactivar la cuenta cumple el mismo fin.
- `logout()` limpia `localStorage` y borra la fila de `user_sessions` (así "Cerrar sesión" no espera el timeout del heartbeat).

## Autorización server-side de operaciones sensibles (`Actor`)

CLIO no tiene backend propio — `db.ts` corre en el mismo proceso que la UI y usa el token de Turso embebido en el bundle (constraint aceptado, ver [ARCHITECTURE.md](ARCHITECTURE.md#constraints-aceptados-no-son-descuidos)). Los checks de `hasPermission`/`isAdmin` en el render de cada pantalla, por diseño, son bypasseables por alguien con acceso a devtools/consola y ese token.

Como defensa en profundidad — no como sustituto real de un backend — `createUser`, `updateUser`, `executeRestoreSql`, `deleteBackupRecord` y `updateBackupSettings` reciben un `Actor` (`{id, token}`, expuesto por `useAuth()`) como primer argumento y lo verifican **contra la BD** con `assertActorAuthorized()` en `db.ts` (sesión vigente + rol admin o el permiso específico) antes de ejecutar. Esto no protege contra alguien que ya tiene el token de Turso y sabe qué SQL correr a mano, pero sí evita que un botón mal gateado, un bug de UI, o llamar estas funciones "a mano" desde la consola sin una sesión real de por medio ejecute la operación. `runBackupNow` (crear backup) queda deliberadamente **fuera** de este check: la usan tanto el botón manual (gateado por `backups_crear` en la UI) como los hooks automáticos de pre-importación/pre-restauración, que deben poder correr sin importar si el usuario actual tiene ese permiso puntual — es una red de seguridad, no una acción discrecional.

## Contraseñas (`UsersPanel`)

Mínimo 8 caracteres, letra + dígito. Guard: no se puede desactivar/degradar al último admin activo.
