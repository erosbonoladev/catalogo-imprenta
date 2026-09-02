# Módulos — estado real

Estados: **IMPLEMENTADO** · **EN DESARROLLO** (parcialmente conectado) · **PLANEADO** (decidido, sin código) · **NO IMPLEMENTADO** (no existe, aunque el tipo/tabla exista).

No asumir que algo existe por aparecer en una conversación previa o en un doc viejo — este archivo se corrige contra el código real cuando cambie.

| Módulo | Estado | Gate | Detalle |
|---|---|---|---|
| Fichas técnicas (catálogo base) | IMPLEMENTADO | Ninguno | CRUD completo, `SearchScreen`→`ProductDetail`→`ProductForm` |
| Piezas (catálogo, antes "Plásticos") | IMPLEMENTADO | `plasticos` | Reutilizable entre fichas vía `PlasticProductPicker` |
| Imprenta — ficha técnica de producción | IMPLEMENTADO | `imprenta` | Specs fijos + checks + extras + "imágenes de armado" |
| Imprenta — historial de órdenes de producción/compra | IMPLEMENTADO | `imprenta` | Ver [WORKFLOWS.md](WORKFLOWS.md#producción--compra) |
| Requisiciones — crear y enviar por WhatsApp | IMPLEMENTADO | `requisiciones` | Ver [WORKFLOWS.md](WORKFLOWS.md#requisiciones) |
| Requisiciones — seguimiento de estado tras creación | **NO IMPLEMENTADO** | — | `ESTADOS_REQUISICION` existe en `types.ts` pero ninguna función de `db.ts` lee/lista/actualiza `estado`; no hay pantalla de seguimiento. Toda requisición queda en `pendiente` para siempre en la BD |
| Folios (numeración de documentos) | IMPLEMENTADO (solo escritura) | — | Sin listado/consulta histórica. Escrito por `createFolio` (Compra/Producción/Requisición) o dentro de `createRemisionConFolio`/`createRequisicionConFolio` (ver [DATABASE.md](DATABASE.md)) |
| Importación masiva de fichas (Excel) | IMPLEMENTADO | `isAdmin` (no es permiso otorgable) | Usa `xlsx`; ver [WORKFLOWS.md](WORKFLOWS.md#importación-de-fichas-excel) |
| Importación masiva de imágenes | IMPLEMENTADO | `isAdmin` | Empareja por nombre de archivo = `codigo` |
| Exportación a PDF (orden/compra/requisición) | IMPLEMENTADO | — | `jspdf`, ver [WORKFLOWS.md](WORKFLOWS.md#pdf) |
| Tema claro/oscuro | IMPLEMENTADO | — | Toggle en Sidebar, persiste en `localStorage` |
| Barra lateral (Sidebar) | IMPLEMENTADO | — | Es chrome persistente (tema, atajo a Remisiones, logout, config, updater) — **no** es un menú de navegación entre pantallas. Remisiones es una fila ícono+texto debajo del toggle de tema (con divisor), Configuraciones sigue siendo el ícono cuadrado de abajo |
| Usuarios/Configuraciones/Registro/Conectados | IMPLEMENTADO | `configuraciones` | Ver [PERMISSIONS.md](PERMISSIONS.md) |
| Auto-actualización | IMPLEMENTADO | — | `@tauri-apps/plugin-updater`+`plugin-process`, botón en Sidebar |
| Modo offline | NO IMPLEMENTADO | — | Constraint aceptada, ver [ARCHITECTURE.md](ARCHITECTURE.md) |
| Optimización/resize de imágenes | NO IMPLEMENTADO | — | Se guardan tal cual se importan |
| Backups — manual, pre-importación, restauración (desde historial y archivo subido) | IMPLEMENTADO | `backups_*` (otorgables individualmente) | `BackupsPanel.tsx` dentro de Configuraciones. Ver [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) |
| Backups — automático programado | IMPLEMENTADO, pero **desactivado por defecto** (`backup_settings.automatico_activado = 0`) | `backups_configurar` para prenderlo | Corre en un repo GitHub separado (`clio-backups`), no dentro de Clio ni de este repo — ver [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) |
| Backups — verificación por restauración real en staging | **NO IMPLEMENTADO** | — | Hoy la verificación es estructural (tamaño, formato, conteo de filas contra el manifiesto embebido), no una restauración real en una BD de prueba — ver "Limitaciones conocidas" en [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) |
| Precios — captura masiva (Excel), consulta/edición por ficha, agrupación por SKU principal | IMPLEMENTADO | `precios_ver`/`precios_modificar` (edición); captura masiva es `isAdmin` | Tabla `precios` + `precios_historial` (solo se escribe, sin pantalla de consulta todavía). `PreciosModal` desde `ProductDetail`; `PreciosImportPanel` dentro de "Captura masiva" en Configuraciones |
| Remisiones — internas (crear, PDF sobre plantilla, cancelar) | IMPLEMENTADO | `remisiones_acceso`/`remisiones_crear`/`remisiones_cancelar` | `RemisionesSection`/`RemisionForm`, folio vía `createFolio("remision", …)`, PDF vía `buildRemisionPdf` (plantilla `Assets/remision-template.png`, rasterizada de `Assets/remision.pdf`). El buscador de renglones consulta `precios` (`searchPrecios`), no `products` — hay entrada manual (SKU+nombre a mano) para lo que no está en ninguna de las dos. `pedido_bodegas` fijo en `"JALISCO"`, no capturable |
| Remisiones — externas | **PLANEADO** | `remisiones_acceso` | Selector "Tipo de remisión" existe y muestra "Externa" deshabilitada ("Próximamente"); sin lógica ni tablas propias |
| Lista de precios / Historial de remisiones (exportación Excel) | IMPLEMENTADO | `backups_ver` | Botones dentro de `BackupsPanel` (Configuraciones → Backups), no relacionados con el sistema de backups en sí — ver [PERMISSIONS.md](PERMISSIONS.md) |

## Notas de precisión

- "Requisiciones" como *feature de negocio completa* (crear → surtir → cerrar) está a medias: la mitad de creación/notificación funciona end-to-end; la mitad de seguimiento/gestión no existe. No decir "implementado" sin esta aclaración.
- La importación por Excel **ya no es planeada** — está completamente implementada. Si se pidiera "agregar importación masiva", el trabajo real sería sobre `fichaImport.ts`/`FichaImportPanel.tsx` existentes, no un módulo nuevo.
