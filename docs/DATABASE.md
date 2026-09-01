# Base de datos

Turso (libSQL/SQLite hosteado). Sin migration runner: el esquema se creó completo con un script one-off. Toda la app accede vía `src/db.ts` — ningún otro archivo importa `@libsql/client`.

Patrón dominante: **replace-and-reinsert** en cada guardado para tablas hijas de lista libre (specs, checks, extras, plastic items, user_permissions) — se borra todo lo del padre y se reinserta. Excepciones: `plastic_products` (master data, nunca se borra-reinserta, solo se actualiza), y las tablas insert-only (`requisiciones`, `folios`, `product_print_item_orders/purchases`, `app_logs`, `remisiones`/`remision_renglones`) que son historial/log, nunca se reemplazan.

`createRemision` es el único lugar que usa `client.batch()` (transacción atómica de libSQL) en vez de `client.execute()` sueltos — header + renglones se escriben todos o ninguno. Es el precedente a seguir si una futura tabla necesita "documento con líneas" (igual que `remisiones`/`remision_renglones`); no repetir el patrón secuencial antiguo (`createProduct`/`insertSpecs`) para ese tipo de escritura donde un folio ya fue consumido antes del insert.

## Tablas activas

| Tabla | Columnas | Notas |
|---|---|---|
| `products` | `codigo` (unique), `nombre`, `categoria`, `material`, `descripcion`, `imagen`/`imagen_mime` (BLOB), `presentacion_original`, `creado_en`, `actualizado_en` | `presentacion_original` guarda el texto crudo de la celda de importación Excel para auditoría; `actualizado_en` se refresca en cada UPDATE. `descripcion` es específicamente la descripción de **Catálogo** — las demás viven en `product_descriptions` |
| `product_specs` | `product_id`, `etiqueta`, `valor`, `orden`, `permite_requisicion` | Schemaless a propósito (distintos productos necesitan distintos specs). `permite_requisicion` controla si esa fila muestra el botón "Requisición" en `ProductDetail` |
| `product_descriptions` | `product_id`, `etiqueta`, `texto`, `orden` | Descripciones adicionales de la ficha (Página web, Licitación, y cualquier tipo que el usuario agregue) — Catálogo NO está aquí, vive en `products.descripcion`. Schemaless igual que `product_specs`; `src/descriptions.ts` combina ambas fuentes para la UI (`buildDescriptionSlots`/`ensureFixedDescriptions`) |
| `plastic_products` | `nombre`, `sku`, `color`, `origen`, `descripcion`, `armado`, `dimension`, `peso`, `tipo_empaque`, `imagen`/`imagen_mime`, `imagen_codigo_barras`/`imagen_codigo_barras_mime`, `creado_en` | Catálogo maestro "Piezas" (reutilizable entre fichas). `createPlasticProduct`/`updatePlasticProduct` nunca forman parte del ciclo replace-and-reinsert |
| `product_plastic_items` | `product_id`, `plastic_product_id`, `orden` | Join ficha↔pieza. Quitar de una ficha solo borra esta fila, no la maestra |
| `product_print_items` | `nombre`, columnas de producción (ver mapeo abajo), `numero_placas`, `placas_existentes` (`""\|"si"\|"no"`), `acabados`, `notas`, `orden` | Todo `TEXT`, sin parseo de unidades |
| `product_print_item_checks` | `print_item_id`, `nombre`, `marcado` (0/1), `orden` | Exactamente los 5 nombres fijos de `PROCESOS_IMPRENTA` en `types.ts`; `getPrintItems` siempre normaliza a esa lista/orden — la UI no permite agregar/renombrar checkboxes |
| `product_print_item_extras` | `print_item_id`, `etiqueta`, `valor`, `orden` | Segmentos libres label/value ("+ Agregar otro segmento") |
| `product_print_item_images` | `print_item_id`, `imagen`/`imagen_mime` (BLOB), `orden` | "Imágenes de armado", tope = `numero_pliegos` |
| `product_print_item_orders` | `print_item_id`, `merma`, `cantidad_arte`, `numero_tiros`, `formacion_usada`, `numero_pliegos_usado`, `total_pliegos`, `usuario`, `folio`, `creado_en` | Una fila por orden de producción generada. Ver [WORKFLOWS.md](WORKFLOWS.md) |
| `product_print_item_purchases` | `print_item_order_id` (FK), `papel`, `pliego`, `maquina`, `cortes`, `cantidad`, `total_tamanos`, `usuario`, `folio`, `creado_en` | Una fila por orden de compra, siempre ligada a una orden de producción |
| `users` | `username` (unique), `password_hash` (bcrypt), `activo`, `rol` (`usuario`\|`admin`), `creado_en`, `failed_attempts`, `locked_until`, `session_token` | Login con bloqueo y sesión por token — ver [PERMISSIONS.md](PERMISSIONS.md) |
| `user_permissions` | `user_id`, `permiso` | Texto libre validado contra `PERMISOS` en `types.ts` |
| `user_sessions` | `user_id` (PK) → `last_seen` | Una fila por **cuenta**, no por dispositivo. Heartbeat — ver [ARCHITECTURE.md](ARCHITECTURE.md) |
| `app_logs` | `nivel`, `mensaje`, `usuario`, `creado_en` | `clearLogs()` permite vaciarla desde `LogsPanel` ("Limpiar"). Sin rotación automática |
| `folios` | `seccion` (`requisicion`\|`compra`\|`produccion`\|`remision`), `consecutivo`, `folio`, `sku`, `creado_en` | `consecutivo` por sección, nunca reinicia. Solo `createFolio` — no hay listado histórico |
| `requisiciones` | `product_id`, `fecha`, `numero_dia` (reinicia diario), `usuario`, `etiqueta`, `descripcion`, `cantidad`, `estado`, `mensaje`, `folio`, `creado_en` | Solo `createRequisicion` existe — nada lee/lista/actualiza `estado` después del insert (ver [MODULES.md](MODULES.md)) |
| `backup_history` | `tipo` (`BACKUP_AUTOMATICO`\|`BACKUP_MANUAL`\|`BACKUP_PRE_IMPORTACION`\|`BACKUP_PRE_RESTAURACION`\|`RESTAURACION`\|`RESTAURACION_ARCHIVO_SUBIDO`\|`CONFIGURACION_CAMBIADA`), `origen`, `usuario`, `archivo`, `ubicacion`, `tamano_bytes`, `checksum_sha256`, `estado` (`EN_PROCESO`\|`EXITOSO`\|`FALLIDO`), `detalle`, `creado_en` | Insert-only, como `requisiciones`/`app_logs` — nunca se reemplaza. `ubicacion` guarda la ruta local absoluta O la URL del asset de GitHub Release, según dónde vive ese backup — no solo la palabra "local"/"github". Ver [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) |
| `backup_settings` | Fila única (`id=1`): `automatico_activado`, `frecuencia`, `hora_ejecucion`, `intervalo_horas`, `dia_semana`, `retencion_diaria_dias`, `retencion_semanal_dias`, `retencion_mensual_dias`, `ultimo_automatico_en`, `actualizado_en`, `actualizado_por` | Leída tanto por Clio (panel de Programación) como por el workflow de GitHub Actions del repo separado `clio-backups` — es la fuente de verdad de "cuándo toca" un backup automático, no un cron fijo en YAML |
| `precios` | `sku` (unique), `sku_principal` (SKU sin las letras finales — ver `computeSkuPrincipal` en `src/precios.ts`), `nombre`, `precio`, `actualizado_en`, `actualizado_por`, `creado_en` | Un SKU con letra (`8059C`) es su propia fila, agrupada bajo `sku_principal="8059"` — no requiere que exista un producto con código `8059` |
| `precios_historial` | `sku`, `precio_anterior`, `precio_nuevo`, `usuario`, `creado_en` | Insert-only, se escribe en cada `upsertPrecio`. Independiente del snapshot de precio que guarda cada renglón de remisión — no confundir los dos |
| `remisiones` | `folio`, `fecha`, `tipo` (`interna`\|`externa`), `pedido_bodegas`, `cancelada`, `subtotal`, `descuento_pct`, `descuento`, `iva`, `total`, `precio_texto`, `usuario`, `creado_en` | Cabecera del documento. Solo existe el flujo `interna` — `tipo` está preparado para `externa` pero nada la escribe todavía. `pedido_bodegas` siempre es `"JALISCO"` para `interna` (constante `PEDIDO_BODEGAS_INTERNA` en `RemisionForm.tsx`, no es un campo capturable) |
| `remision_renglones` | `remision_id` (FK), `numero_renglon`, `sku`, `producto_nombre`, `cantidad`, `precio_unitario`, `importe` | `sku`/`producto_nombre`/`precio_unitario` son un snapshot congelado al crear la remisión — nunca se vuelven a leer de `products`/`precios` después del insert, ni siquiera si el precio del producto cambia después |

## Mapeo de columnas heredado (`product_print_items`)

El tipo `PrintItem` no coincide 1:1 con las columnas (compatibilidad con filas antiguas):

| Campo en `types.ts` | Columna real |
|---|---|
| `tamano_extendido` | `extendido` |
| `tamano_final` | `tamano` |
| `cortes_tamano` | `corte_cm` |

El resto (`tintas`, `tipo_papel`, `gramos_puntos`, `pliego`, `maquina`, `formacion`, `numero_pliegos`) mapea directo.

## Tablas y columnas muertas — no resucitar sin confirmar con el usuario

- `product_plastic_pieces` + `getPlasticPieces`/`savePlasticPieces` en `db.ts`: reemplazadas por `plastic_products`/`product_plastic_items`.
- `section_passwords`: del viejo sistema de contraseña por sección (pre-usuarios).
- Columnas sin usar en `product_print_items`: `cantidad`, `numero_cortes`, `total`, `merma`, `buenos`, `pliegos_imprimir`, `cada_pliego`, `total_artes`, `existencias`, `total_general`.
- `@tauri-apps/plugin-sql` sigue en `package.json` pero no se usa en ningún lado (la DB se accede por HTTPS/WebSocket vía `@libsql/client`, no por plugin de Tauri).

No se eliminan por ser cambios de esquema/dependencias en una BD compartida en vivo con datos reales, no por descuido.

## Funciones de `db.ts` por dominio

- **Products/specs**: `searchProducts`, `getProduct`, `getProductSpecs`, `getProductDescriptions`, `createProduct`, `updateProduct` (ambas reciben `descriptions` además de `specs`), `deleteProduct` (cascada a specs/descriptions/plastic items/print items/orders/purchases/images), `findProductByCodigo`, `findProductsByNombre`, `setPresentacionOriginal`, `codigoEnUso`.
- **Imágenes**: `getImageSrc`, `pickImage`, `updateProductImage`, `pickExcelFile`, `pickImageFolder`, `listImageFolderFiles`, `readImageFileBlob`, `MIME_BY_EXT`.
- **Usuarios/auth**: `verifyLogin` (retorna `ok|invalid|locked`), `validateSession`, `listUsers`, `usernameEnUso`, `createUser`, `updateUser`.
- **Sesiones**: `heartbeat`, `clearSession`, `getConnectedUsers`.
- **Logs**: `logEvent`, `getRecentLogs`, `clearLogs`.
- **Piezas (catálogo)**: `searchPlasticProducts`, `createPlasticProduct`, `updatePlasticProduct`, `getPlasticItems`, `savePlasticItems`.
- **Imprenta (ficha)**: `getPrintItems`, `savePrintItems`.
- **Imprenta (órdenes)**: `createPrintItemOrder`, `getPrintItemOrders`, `createPrintItemPurchase`, `getPrintItemPurchases`, `deletePrintItemOrder`, `deletePrintItemPurchase`.
- **Folios**: `createFolio`.
- **Requisiciones**: `createRequisicion`.
- **Precios**: `upsertPrecio` (INSERT...ON CONFLICT, también escribe `precios_historial`), `getPrecio`, `getPreciosBySkuPrincipal`, `getPreciosList`, `searchPrecios` (SKU normal o con letra / nombre — usada por el buscador de `RemisionForm`, no por `searchProducts`).
- **Remisiones**: `createRemision` (header + renglones en un solo `client.batch()` — **no** el patrón secuencial de `createProduct`/`insertSpecs`: el folio ya quedó consumido por `createFolio` antes de llegar aquí, así que un fallo a medias dejaría un documento fantasma con folio quemado y renglones incompletos; cada renglón ubica su `remision_id` con `(SELECT id FROM remisiones WHERE folio = ?1)` en vez de encadenar el id devuelto por el insert del header, porque `batch()` arma todos los statements de antemano), `listRemisiones`, `cancelRemision`, `listRemisionRenglonesParaHistorial` (join usado por la exportación "Historial de remisiones").
- **Backups**: `createBackupSql`/`executeRestoreSql`/`verifyRestoreCounts` (dump y restauración crudos), `runBackupNow` (orquesta dump+verificar+guardar+registrar — un solo punto de entrada usado por el botón manual y por el hook de pre-importación), `createBackupRecord`/`updateBackupRecord`/`deleteBackupRecord`/`listBackupHistory`/`getLatestBackup` (tabla `backup_history`), `getBackupSettings`/`updateBackupSettings` (tabla `backup_settings`), `getBackupsDir`/`saveLocalBackupFile`/`readLocalBackupFile`/`localBackupFileExists`/`deleteLocalBackupFile`/`saveBackupFileAs`/`pickBackupFile` (I/O local bajo el directorio de datos de la app). La lógica pura de armado/parseo de dumps (escapado SQL, split de statements, checksum, gzip) vive en `src/backup.ts`, sin tocar la BD, para poder reusarse igual en el script Node del repo `clio-backups`. Ver [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md).

Agregar queries nuevas aquí, nunca inline en un componente.
