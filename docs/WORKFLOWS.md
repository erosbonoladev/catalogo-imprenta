# Flujos completos

## Requisiciones

1. Un editor marca una fila de spec con `permite_requisicion` en `ProductForm`.
2. Un usuario con permiso `requisiciones` ve un botón "Requisición" junto a esa fila en `ProductDetail`, que abre `RequisicionModal`.
3. Al enviar una cantidad: se genera un folio (`createFolio("requisicion", sku)`), se arma un PDF (`buildRequisicionPdf`), se ofrece guardarlo (best-effort: si el usuario cancela el diálogo de guardado, el flujo de WhatsApp continúa igual), se inserta una fila en `requisiciones` (`estado` siempre `"pendiente"`, `numero_dia` calculado atómicamente y reiniciado por día), y se abre un link `wa.me` a `VITE_WHATSAPP_BODEGA_NUMBER` con un mensaje prearmado (`buildRequisicionMessage`, distinto texto si es la primera del día o una adicional).
4. **No hay paso 4.** Nada vuelve a leer esa fila — no existe pantalla de seguimiento ni función para cambiar `estado`. Ver [MODULES.md](MODULES.md).

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

`src/pdf.ts`, librería `jspdf`. Tres builders, todos con encabezado de logo corporativo (`Assets/perspectiva.jpeg`):

| Builder | Se dispara desde |
|---|---|
| `buildOrderPdf` | `ProduccionForm` |
| `buildPurchasePdf` | `CompraForm` / `OrderModal` |
| `buildRequisicionPdf` | `RequisicionModal` |

Los bytes se guardan con `@tauri-apps/plugin-dialog`'s `save()` + `@tauri-apps/plugin-fs`'s `writeFile()`.

## Heartbeat de usuarios conectados

Mientras hay sesión, `AuthProvider` actualiza `user_sessions.last_seen` cada 20s y borra oportunísticamente filas con más de 90s de antigüedad. `ConnectedUsersPanel` hace poll de `getConnectedUsers()` cada 12s mientras esa pestaña está abierta. Lag aceptado: hasta ~90s tras un cierre abrupto; misma cuenta en dos máquinas cuenta una sola vez.

## Auto-actualización

`UpdateChecker.tsx` en el Sidebar: un clic llama `check()` (`@tauri-apps/plugin-updater`); si hay actualización, un segundo clic descarga con progreso y llama `relaunch()` (`@tauri-apps/plugin-process`). Config en `tauri.conf.json` → `plugins.updater` (clave pública minisign + endpoint de GitHub Releases).
