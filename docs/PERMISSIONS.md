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
- **`isAdmin(user)`** (`auth.tsx`): gate independiente, más estricto, para pantallas que **no son otorgables como permiso normal** — son exclusivas del rol admin: `FichaImportPanel`, `ImageImportPanel`, `PreciosImportPanel` (los tres sub-paneles de la pestaña "Captura masiva" en `Configuraciones`, ver `CapturaMasivaPanel.tsx`).

Regla: todo screen gateado debe llamar a `hasPermission`/`isAdmin` **en su propio render**, no confiar solo en que el botón de entrada esté oculto (`PlasticosSection`, `ImprentaSection`, `Configuraciones` renderizan "Acceso denegado" si falla el check).

## Sesión

- Login (`LoginScreen` → `useAuth().login` → `verifyLogin()` en `db.ts`) usa el comando Rust `verify_password` (bcrypt). Retorna `ok | invalid | locked`.
- **Bloqueo de cuenta**: 5 intentos fallidos → bloqueo de 15 min (`users.failed_attempts`/`locked_until`).
- **Sesión por token**: al loguear se genera `session_token` (columna en `users`), se guarda `{id, token}` en `localStorage`. Al iniciar la app, `validateSession(id, token)` revalida contra la BD — nunca se confía en el `localStorage` cacheado. Cambiar la contraseña de un usuario anula su `session_token` (fuerza logout en otras sesiones).
- `logout()` limpia `localStorage` y borra la fila de `user_sessions` (así "Cerrar sesión" no espera el timeout del heartbeat).

## Contraseñas (`UsersPanel`)

Mínimo 8 caracteres, letra + dígito. Guard: no se puede desactivar/degradar al último admin activo.
