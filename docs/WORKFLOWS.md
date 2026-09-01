# Flujos completos

## Requisiciones

1. Un editor marca una fila de spec con `permite_requisicion` en `ProductForm`.
2. Un usuario con permiso `requisiciones` ve un botón "Requisición" junto a esa fila en `ProductDetail`, que abre `RequisicionModal`.
3. Al enviar una cantidad: se genera un folio (`createFolio("requisicion", sku)`), se arma un PDF (`buildRequisicionPdf`), se ofrece guardarlo (best-effort: si el usuario cancela el diálogo de guardado, el flujo de WhatsApp continúa igual), se inserta una fila en `requisiciones` (`estado` siempre `"pendiente"`, `numero_dia` calculado atómicamente y reiniciado por día), y se abre un link `wa.me` a `VITE_WHATSAPP_BODEGA_NUMBER` con un mensaje prearmado (`buildRequisicionMessage`, distinto texto si es la primera del día o una adicional).
4. **No hay paso 4.** Nada vuelve a leer esa fila — no existe pantalla de seguimiento ni función para cambiar `estado`. Ver [MODULES.md](MODULES.md).

## Remisiones

1. Sección gateada por `remisiones_acceso` en el Sidebar (fila debajo de "Modo oscuro" — ver [ARCHITECTURE.md](ARCHITECTURE.md#navegación)). Dentro, un selector "Tipo de remisión": Interna (activa) / Externa (deshabilitada, "Próximamente", sin lógica).
2. `RemisionForm.tsx` (visible solo con `remisiones_crear`): el buscador consulta `searchPrecios` (tabla `precios`, **no** `searchProducts`/`products`) — acepta SKU normal o con letra (ej. `7078E`) o nombre. Al elegir un resultado se agrega un renglón con SKU/nombre/precio ya resueltos de esa fila de `precios`, sin otra consulta.
3. Si el SKU tampoco existe en `precios`, "¿No aparece en el catálogo? Agregarlo manualmente" captura SKU + nombre a mano (cantidad/precio quedan editables en la tabla) — para que quien arma la remisión pueda incluir algo que tiene físicamente aunque no esté cargado en el sistema. Internamente reintenta la búsqueda por SKU principal (`computeSkuPrincipal`, mismo agrupamiento que `PreciosModal`) antes de dejar el precio en blanco.
4. Folio automático vía `createFolio("remision", primerSku)` — mismo mecanismo que Requisiciones/Producción/Compra, prefijo `REM`. Fecha automática (`fechaLocalDeHoy()`). `pedido_bodegas` siempre `"JALISCO"` (constante `PEDIDO_BODEGAS_INTERNA`) — no es un campo del formulario, las remisiones internas son siempre para esa bodega.
5. Cálculos en vivo: Subtotal = Σ cantidad×precio; Descuento = Subtotal × Descuento%/100 (validado 0–100); IVA = Subtotal × 16% fijo; Total = Subtotal − Descuento − IVA (bloqueado si da negativo); Precio en texto vía `numeroATextoMoneda` (`src/numeroALetras.ts`).
6. Al confirmar, `createRemision` (ver [DATABASE.md](DATABASE.md)) es el punto de no retorno: si falla, nada se reporta como generado. Si la remisión sí se guardó pero `buildRemisionPdf`/el diálogo de guardado fallan después, la remisión sigue contando como generada (la lista se refresca igual, hay un mensaje aparte solo para el problema del PDF) — nunca debe parecer que no pasó nada cuando sí se consumió el folio y se guardó el documento.
7. El precio de cada renglón es un snapshot — `remision_renglones.precio_unitario`/`producto_nombre` nunca se vuelven a leer de `precios`/`products` después de guardar, ni si el precio del producto cambia luego.
8. "Remisiones recientes" debajo del formulario (`listRemisiones`), con botón "Cancelar" por fila si `remisiones_cancelar` (`cancelRemision` marca `cancelada=1`, no borra la fila).

## Captura masiva de precios

Admin-only (`isAdmin`), tercera opción dentro de la pestaña "Captura masiva" en Configuraciones (junto a fichas técnicas e imágenes — las tres viven en `CapturaMasivaPanel.tsx`, ver [MODULES.md](MODULES.md)).

1. Excel con columnas SKU, Nombre, Precio, Fecha de actualización (`readPreciosWorkbook` en `src/precios.ts`). La fecha acepta `DD/MM/AAAA`, `AAAA-MM-DD`, o fecha+hora ISO 8601 completa (ej. `2026-07-13T15:48:42.128Z` — se usa solo la parte de fecha). `Date.UTC` no se confía a ciegas para validar rango: `buildAndValidateDate` rechaza algo como `31/04` en vez de dejarlo normalizarse silenciosamente a `1/05`.
2. `classifyPrecioRows` marca cada fila `valido` (el SKU principal existe como producto), `no_encontrado` (no existe, pero se guarda igual — un SKU con letra puede ser válido sin tener ficha técnica propia) o `error` (SKU/nombre/precio/fecha faltante o inválido, o SKU repetido dentro del archivo). Solo `error` bloquea el guardado de esa fila.
3. `PreciosImportPanel.tsx` sigue el mismo wizard de fases que fichas/imágenes (elegir → validar → revisar → **backup previo obligatorio** vía `runBackupNow` → confirmar → aplicar), con el commit en chunks concurrentes (`Promise.all` de a `CHUNK_SIZE = 25`, no un `upsertPrecio` awaited por fila uno a uno) para no pagar un viaje de red por cada renglón en archivos grandes.
4. La fecha del Excel se guarda tal cual como `precios.actualizado_en` (parámetro `actualizadoEn` de `upsertPrecio`) — a diferencia de una edición manual desde `PreciosModal`, que siempre usa el momento real (`datetime('now')`).

## Producción / compra

Desde `ImprentaSection` (modo vista), "Crear orden general" o un botón por ítem abre `OrderModal` (pestañas PRODUCCIÓN/COMPRA).

- **Producción** (`ProduccionForm.tsx`): captura merma, cantidad de arte, número de tiros por ítem → `total_pliegos = ceil((cantidad_arte / formacion + merma) * pliegos)` → genera folio `produccion` + PDF (`buildOrderPdf`) → inserta fila en `product_print_item_orders`.
- **Compra** (`CompraForm.tsx`, también disparable en lote desde `OrderModal`): elige una orden de producción base → `cantidad = ceil(orden.total_pliegos / cortes)` → genera folio `compra` + PDF (`buildPurchasePdf`) → inserta fila en `product_print_item_purchases` ligada a esa orden.
- Historial browsable/borrable por ítem en "Historia de órdenes y compras" dentro de `ImprentaSection`.

## Importación de fichas (Excel)

Admin-only (`isAdmin`), pestaña "Captura masiva de fichas técnicas" en Configuraciones.

1. `pickExcelFile()` (diálogo nativo).
2. `readWorkbook()` valida 7 encabezados esperados: Clave, Producto, Categoría, Descripción, "Presentación / Contenido", Medidas, Material.
3. `classifyRows()` empareja cada fila contra productos existentes por código/nombre (detecta duplicados dentro del mismo archivo).
4. `buildSpecsForRow()`/`parsePresentacionContenido()` separa heurísticamente (regex de cantidad/unidad) la celda libre de presentación en filas de spec estructuradas.
5. `FichaImportPanel.tsx` corre un wizard: elegir archivo → validar → revisar (toggle Sobrescribir/Omitir por fila duplicada) → confirmar → aplicar (`createProduct`/`updateProduct`/`setPresentacionOriginal`) → listo.

## Importación de imágenes

Admin-only, mismo grupo de pestañas. Reemplaza/asigna solo el BLOB `imagen` de fichas existentes emparejando el nombre de archivo (sin extensión) de una carpeta elegida contra `codigo` (`findProductByCodigo`). Mismo wizard de 5 fases que la importación de fichas, con toggle Sustituir/Conservar para productos que ya tienen imagen. No usa hoja de cálculo.

## PDF

`src/pdf.ts`, librería `jspdf`. Cuatro builders:

| Builder | Se dispara desde |
|---|---|
| `buildOrderPdf` | `ProduccionForm` |
| `buildPurchasePdf` | `CompraForm` / `OrderModal` |
| `buildRequisicionPdf` | `RequisicionModal` |
| `buildRemisionPdf` | `RemisionForm` |

Los tres primeros dibujan sobre un lienzo en blanco (`new jsPDF({format:"letter"})`) con encabezado de logo corporativo (`Assets/perspectiva.jpeg`). `buildRemisionPdf` es distinto: en vez de lienzo en blanco usa `Assets/remision-template.png` (rasterizado una sola vez de `Assets/remision.pdf`, la plantilla oficial de Perspectiva Gráfica, tamaño A4 real — `format: [595.5, 842.25]`, no `"letter"`) como fondo de cada página vía `doc.addImage`, con texto dinámico encima en coordenadas medidas a mano sobre esa imagen. Folio/fecha/pedido bodegas se tapan primero con un rectángulo blanco (los valores de ejemplo `XXXXXX`/`DD/MM/AA`/`JALISCO` vienen horneados en la plantilla original) antes de escribir el valor real — igual con "Precio en texto" por seguridad, aunque ahí la plantilla no trae ningún ejemplo. Se repiten en cada página, no solo la primera. Nombres de producto muy largos se truncan con "…" (`truncateToWidth`) en vez de perderse sin aviso en un documento impreso. Multi-página: 15 renglones por página (medido contra la plantilla); los totales y el precio en texto solo se escriben en la última página.

Los bytes se guardan con `@tauri-apps/plugin-dialog`'s `save()` + `@tauri-apps/plugin-fs`'s `writeFile()`.

## Heartbeat de usuarios conectados

Mientras hay sesión, `AuthProvider` actualiza `user_sessions.last_seen` cada 20s y borra oportunísticamente filas con más de 90s de antigüedad. `ConnectedUsersPanel` hace poll de `getConnectedUsers()` cada 12s mientras esa pestaña está abierta. Lag aceptado: hasta ~90s tras un cierre abrupto; misma cuenta en dos máquinas cuenta una sola vez.

## Auto-actualización

`UpdateChecker.tsx` en el Sidebar: un clic llama `check()` (`@tauri-apps/plugin-updater`); si hay actualización, un segundo clic descarga con progreso y llama `relaunch()` (`@tauri-apps/plugin-process`). Config en `tauri.conf.json` → `plugins.updater` (clave pública minisign + endpoint de GitHub Releases).
