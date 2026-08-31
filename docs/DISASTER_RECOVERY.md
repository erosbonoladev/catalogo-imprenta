# Backups y recuperación ante fallas

Sistema de respaldo local de la base de datos de producción (Turso), pensado como red de seguridad ante errores de captura masiva, corrupción de datos o borrados accidentales. La BD de producción sigue siendo Turso — esto no es una migración de base de datos, es una copia de seguridad independiente.

## Arquitectura

```
Clio → Turso → runBackupNow() → dump SQL → gzip → guardado local (manual/pre-importación/pre-restauración)
                    ↑
       GitHub Actions (repo separado "clio-backups", schedule horario)
                    → dump SQL → gzip → GitHub Release (backup automático programado)
```

Dos caminos, mismo formato de dump, mismo destino final de auditoría (tabla `backup_history` en Turso):

1. **Disparado desde la app** (botón manual, hook previo a importaciones, backup de emergencia antes de restaurar): corre dentro del webview de Clio, usa `src/backup.ts` (lógica pura) + `src/db.ts` (`runBackupNow`), y guarda el archivo `.sql.gz` localmente bajo `appDataDir()/backups` de la máquina donde se disparó.
2. **Automático programado**: corre en `github.com/erosbonoladev/clio-backups`, un repositorio **privado, separado del código de la app** — no un fork accidental, es la pieza de infraestructura que Clio necesitaba porque la app de escritorio no tiene ningún proceso "siempre encendido". Un workflow con `schedule:` horario (`.github/workflows/backup.yml`) lee la tabla `backup_settings` en cada corrida y decide si, según la frecuencia/hora que configuraste en Clio, toca hacer un backup ahora. Si toca, publica el archivo como asset de un GitHub Release en ese mismo repo.

**Por qué dos caminos y no uno**: un backup manual/pre-importación tiene que existir *ya*, de forma síncrona, antes de que la operación que lo disparó continúe — no puede depender de que GitHub Actions esté disponible en ese instante. El automático, en cambio, necesita correr sin que nadie tenga la app abierta — algo que la app misma no puede garantizar. Cada uno resuelve el problema que el otro no puede.

## Formato del backup

Un archivo `clio_<fecha>_<hora>.sql.gz`: SQL estándar (schema completo vía `DROP TABLE IF EXISTS`+`CREATE TABLE` re-emitido tal cual está en `sqlite_master`, seguido de `INSERT` por fila, BLOBs como literales `X'...'`) comprimido con gzip, con una primera línea de metadata:

```sql
-- CLIO_BACKUP_META {"version":1,"creadoEn":"...","tablas":{"products":1359,...}}
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
...
COMMIT;
```

Es SQL real — técnicamente reproducible con `turso db shell <db> < backup.sql` si alguna vez hace falta salir del flujo de Clio — pero la restauración normal la ejecuta Clio mismo vía `client.batch()` (más seguro que confiar en `BEGIN`/`COMMIT` sueltos por HTTP). El backup incluye **todas** las tablas reales de la BD, incluidas las marcadas como "muertas" en [DATABASE.md](DATABASE.md) — un backup es una foto completa, no un recorte a lo que la app usa hoy.

La lógica de armado/parseo (escapado SQL, split de statements respetando comillas/blobs, checksum, gzip) vive en `src/backup.ts`, sin tocar la BD — así es reutilizable tal cual. El script Node de `clio-backups` es una réplica independiente del mismo formato (viven en repos distintos, no pueden compartir un import).

## Backup automático — configuración

Configuraciones → Backups → Programación (permiso `backups_configurar`). Tres campos: activado/desactivado, frecuencia (diario / cada N horas / semanal + día), hora de ejecución, y retención (días para bucket diario/semanal/mensual). Guardar escribe en `backup_settings` y registra un evento `CONFIGURACION_CAMBIADA` en el historial.

**Importante**: cambiar esto en la UI no reconfigura ningún cron — el workflow de GitHub Actions corre cada hora sin importar qué digas aquí, y en cada corrida decide por sí mismo si "toca" según lo que lea en `backup_settings` en ese momento. Por defecto viene **desactivado** (`automatico_activado = 0`) — actívalo explícitamente cuando quieras que empiece.

## Backup manual

Configuraciones → Backups → "Crear backup ahora" (permiso `backups_crear`). Llama a `runBackupNow("BACKUP_MANUAL", ...)`: arma el dump, lo verifica estructuralmente, lo guarda en `appDataDir()/backups` (la copia interna que el historial/restauración necesitan), y solo entonces lo marca `EXITOSO` en el historial — nunca se marca éxito antes de verificar. Si además tienes permiso `backups_descargar`, justo después se abre el diálogo nativo "Guardar como" para elegir dónde quieres una copia adicional del archivo (memoria USB, carpeta compartida, etc.); cancelar ese diálogo no afecta al backup, que ya quedó guardado y registrado igual.

## Backup previo a importaciones masivas

`FichaImportPanel.tsx` e `ImageImportPanel.tsx` llaman `runBackupNow("BACKUP_PRE_IMPORTACION", ...)` como primer paso de "Confirmar importación", **antes** de escribir cualquier fila. Si el backup falla, la fase vuelve a "reviewing" con un mensaje de error y la importación nunca arranca — no hay forma de saltarse esto desde la UI.

## Restauración

Dos entradas, un solo mecanismo interno (`BackupsPanel.tsx`):

- **Desde el historial**: si el backup vive local en esa máquina, se lee directo y pasa a validación. Si vive en GitHub (los automáticos), el botón abre el navegador al Release — Clio no guarda ningún token de GitHub embebido para bajarlo solo (ver "Decisiones de seguridad" abajo). Después de bajarlo, se sube con la opción de abajo.
- **"Subir archivo de restauración"**: selecciona un `.sql`/`.sql.gz` cualquiera, local o bajado de GitHub. Validado contra `MAX_RESTORE_FILE_BYTES` (200 MB) y contra `validateBackupSql()` (estructura, metadata, conteo de filas por tabla contra lo que dice el propio manifiesto embebido) antes de mostrar nada.

En ambos casos, mismo flujo protegido:

1. Se muestran los metadatos (tablas y filas) del archivo.
2. Hay que escribir literalmente `RESTAURAR` para habilitar "Continuar".
3. Se crea un backup `BACKUP_PRE_RESTAURACION` del estado actual — si este falla, la restauración **no** ocurre.
4. Se ejecuta el restore (`client.batch()` con los `INSERT`/`CREATE TABLE` del dump).
5. Se verifica contra producción: `verifyRestoreCounts()` vuelve a contar filas por tabla y las compara contra el manifiesto del archivo restaurado.
6. Se registra en `backup_history` como `RESTAURACION` (si el archivo coincide por checksum con un backup conocido) o `RESTAURACION_ARCHIVO_SUBIDO` (si no coincide con ninguno).

No se genera ningún archivo temporal fuera de `appDataDir()/backups`: el archivo subido se lee a memoria (`Uint8Array`) y nunca se copia a disco aparte, así que no hay nada que limpiar después.

## Permisos

`backups_ver` / `backups_crear` / `backups_descargar` / `backups_restaurar` / `backups_configurar` / `backups_eliminar` — otorgables individualmente como cualquier otro permiso (`UsersPanel`), admin los tiene todos automáticamente. Detalle y la excepción de gate en `Configuraciones`/`Sidebar`: [PERMISSIONS.md](PERMISSIONS.md).

## Verificación de un backup

Sin restauración real a una BD de prueba (ver "Limitaciones conocidas"), pero no es solo "el proceso terminó":

- El archivo existe y pesa más de 0 bytes.
- Descomprime correctamente (si es `.gz`).
- Tiene el encabezado `-- CLIO_BACKUP_META`, `BEGIN TRANSACTION` y termina en `COMMIT;`.
- El número de `CREATE TABLE` coincide con las tablas listadas en el manifiesto.
- El número de `INSERT` por tabla coincide exactamente con el conteo que el propio manifiesto dice para esa tabla.

Ver `validateBackupSql()` en `src/backup.ts`.

## Procedimiento de recuperación ante una falla

```
1. Detectar el problema (datos corruptos, importación mal hecha, borrado accidental).

2. Identificar el último backup válido:
   Configuraciones → Backups → Historial → busca el más reciente con estado ✓
   (o el archivo de restauración externo que tengas a mano).

3. Crear un backup de emergencia del estado actual ANTES de tocar nada:
   esto pasa automático al iniciar cualquier restauración (paso PRE_RESTAURACION) —
   no hace falta hacerlo a mano, pero si prefieres hacerlo explícito primero:
   "Crear backup ahora".

4. Restaurar: "Restaurar" sobre el backup elegido, o "Subir archivo de restauración"
   si es un archivo externo. Escribe RESTAURAR para confirmar.

5. Verificar (Clio lo hace solo y te muestra el resultado, pero confirma a mano):
   - Login funciona (usuarios/permisos no se corrompieron).
   - Unas cuantas fichas técnicas abren bien (imagen, specs, descripciones).
   - Piezas/Imprenta de un producto conocido siguen ahí.
   - Una búsqueda trae resultados razonables.
   - Si el problema era de captura masiva: confirma que esa importación específica
     efectivamente se revirtió.

6. Reactivar operación normal. Si el backup restaurado no era el más reciente,
   evalúa qué se perdió entre ese punto y ahora (revisa `app_logs`/`requisiciones`/
   `folios` posteriores a la fecha del backup para reconstruir a mano si hace falta).
```

## Decisiones de seguridad (por qué está diseñado así)

- **`clio-backups` es un repo aparte**, no una carpeta dentro de este, para que un backup nunca termine en el historial de git del código fuente por accidente, y para poder darle acceso de colaborador a alguien sin darle acceso al código.
- **Clio no guarda ningún token de GitHub embebido** para bajar backups por sí sola — eso hubiera significado un segundo secreto embebido en el bundle además del de Turso. En cambio, "Restaurar desde historial" de un backup alojado en GitHub abre el navegador (con tu sesión de GitHub) y de ahí usas "Subir archivo de restauración". Ver la auditoría original en el historial de esta conversación si necesitas el razonamiento completo.
- **`clio-backups` usa dos tokens de Turso, no uno.** `TURSO_TOKEN_RO` (`"a":"ro"` en el JWT, verificado: un `INSERT` con este token es rechazado por Turso con `BLOCKED: SQL write operations are forbidden`) se usa exclusivamente para leer las tablas de negocio al armar el dump — si se filtra, no puede escribir ni borrar nada en producción. `TURSO_TOKEN` (el mismo de lectura/escritura que ya va embebido en el bundle de la app, no un secreto nuevo) se usa solo para las 3 tablas de bookkeeping (`backup_history`/`backup_settings`/`app_logs`) — crear/cerrar la fila del backup, actualizar `ultimo_automatico_en`, podar vencidos. Si `TURSO_TOKEN_RO` no está configurado, el script cae de vuelta al token normal para no romper el flujo, pero perdiendo esa protección — confirma con `gh secret list --repo erosbonoladev/clio-backups` que ambos están presentes.

## Limitaciones conocidas

- **Verificación por restauración real en un entorno separado — no implementada.** Requeriría una segunda base Turso "de staging" para replayar el dump ahí y comparar. La verificación actual (estructural + conteo de filas cruzado contra el manifiesto) es real, pero no prueba que el SQL efectivamente se pueda ejecutar de punta a punta en una BD limpia. Para cerrar esto: crea una BD Turso de staging (free tier alcanza), agrega sus credenciales como secret adicional en `clio-backups` (`gh secret set STAGING_TURSO_URL`/`STAGING_TURSO_TOKEN`), y extiende `run.mjs` para restaurar ahí después de cada dump automático.
- **Backups disparados desde la app viven solo en la máquina que los disparó.** Un backup manual o pre-importación no se sube a GitHub en tiempo real (para no necesitar un segundo token de GitHub con permiso de escritura embebido en la app). Si esa laptop específica se pierde antes de que corra el siguiente backup automático, ese backup puntual se pierde con ella — el automático programado sigue funcionando igual, centralizado, sin depender de ninguna máquina en particular.
- **Retención**: el workflow poda Releases vencidos automáticamente (regla dura: nunca el backup válido más reciente), pero los backups guardados *localmente* (manual/pre-importación/pre-restauración) no tienen poda automática todavía — hoy solo se borran a mano desde el historial (permiso `backups_eliminar`).
