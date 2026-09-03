import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { hasPermission, useAuth } from "../auth";
import {
  MAX_RESTORE_FILE_BYTES,
  createBackupRecord,
  deleteBackupRecord,
  executeRestoreSql,
  getBackupSettings,
  getPreciosList,
  listBackupHistory,
  listRemisionRenglonesParaHistorial,
  localBackupFileExists,
  logEvent,
  pickBackupFile,
  readLocalBackupFile,
  runBackupNow,
  saveBackupFileAs,
  updateBackupSettings,
  verifyRestoreCounts,
} from "../db";
import { gunzipToText, isGzip, sha256Hex, validateBackupSql, type BackupValidation } from "../backup";
import { buildPreciosListWorkbook, buildRemisionesHistorialWorkbook } from "../excelExport";
import type { BackupFrecuencia, BackupRecord, BackupSettings, BackupTipo } from "../types";
import Toast from "./Toast";
import basuraIcon from "../../Assets/basura.svg";

const TIPO_LABELS: Record<BackupTipo, string> = {
  BACKUP_AUTOMATICO: "Automático",
  BACKUP_LOCAL_DIARIO: "Automático diario (local)",
  BACKUP_MANUAL: "Manual",
  BACKUP_PRE_IMPORTACION: "Pre-importación",
  BACKUP_PRE_RESTAURACION: "Pre-restauración",
  RESTAURACION: "Restauración",
  RESTAURACION_ARCHIVO_SUBIDO: "Restauración (archivo subido)",
  CONFIGURACION_CAMBIADA: "Configuración cambiada",
};

const FRECUENCIA_LABELS: Record<BackupFrecuencia, string> = {
  diario: "Diario",
  cada_n_horas: "Cada N horas",
  semanal: "Semanal",
};

const DIAS_SEMANA = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const withZone = iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`;
  const date = new Date(withZone);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function computeNextRun(settings: BackupSettings): Date | null {
  if (!settings.automatico_activado) return null;
  const now = new Date();
  const [hh, mm] = settings.hora_ejecucion.split(":").map((n) => parseInt(n, 10));

  if (settings.frecuencia === "cada_n_horas") {
    const horas = settings.intervalo_horas ?? 1;
    const lastIso = settings.ultimo_automatico_en;
    const last = lastIso ? new Date(lastIso.includes("T") ? lastIso : `${lastIso.replace(" ", "T")}Z`) : null;
    const base = last && !Number.isNaN(last.getTime()) ? last : now;
    const next = new Date(base.getTime() + horas * 3_600_000);
    return next > now ? next : new Date(now.getTime() + horas * 3_600_000);
  }

  const next = new Date(now);
  next.setHours(Number.isFinite(hh) ? hh : 3, Number.isFinite(mm) ? mm : 0, 0, 0);

  if (settings.frecuencia === "semanal") {
    const target = settings.dia_semana ?? 0;
    let diff = (target - next.getDay() + 7) % 7;
    if (diff === 0 && next <= now) diff = 7;
    next.setDate(next.getDate() + diff);
    return next;
  }

  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

interface RestoreFlow {
  status: "validating" | "ready" | "invalid" | "confirming" | "running" | "success" | "error";
  fileName: string;
  sql: string;
  validation: BackupValidation | null;
  matchedRecordId: number | null;
  confirmText: string;
  message: string;
  sizeBytes: number;
}

export default function BackupsPanel() {
  const { user, token } = useAuth();
  const canVer = hasPermission(user, "backups_ver");
  const canCrear = hasPermission(user, "backups_crear");
  const canDescargar = hasPermission(user, "backups_descargar");
  const canRestaurar = hasPermission(user, "backups_restaurar");
  const canConfigurar = hasPermission(user, "backups_configurar");
  const canEliminar = hasPermission(user, "backups_eliminar");

  const [settingsDraft, setSettingsDraft] = useState<BackupSettings | null>(null);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  const [history, setHistory] = useState<BackupRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const [creating, setCreating] = useState(false);
  const [exportingPrecios, setExportingPrecios] = useState(false);
  const [exportingRemisiones, setExportingRemisiones] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const [restoreFlow, setRestoreFlow] = useState<RestoreFlow | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  useEffect(() => {
    if (!canVer) {
      setLoading(false);
      return;
    }
    refresh();
  }, [canVer]);

  async function refresh() {
    const [s, h] = await Promise.all([getBackupSettings(), listBackupHistory(50)]);
    setSettingsDraft(s);
    setSettingsDirty(false);
    setHistory(h);
    setLoading(false);
  }

  const ultimo = history[0] ?? null;
  const ultimoExitoso = history.find((h) => h.estado === "EXITOSO") ?? null;
  const espacioLocal = history
    .filter((h) => !h.ubicacion.startsWith("http"))
    .reduce((sum, h) => sum + h.tamano_bytes, 0);
  const estadoOk = ultimo ? ultimo.estado === "EXITOSO" : null;

  async function handleCreateManual() {
    if (!canCrear || creating) return;
    setCreating(true);
    setToastMessage(null);
    try {
      const result = await runBackupNow("BACKUP_MANUAL", "Manual", user?.username ?? null);
      if (!result.ok) {
        setToastMessage(`El backup falló: ${result.errors.join("; ")}`);
        await refresh();
        return;
      }
      if (canDescargar) {
        const bytes = await readLocalBackupFile(result.record.ubicacion);
        const saved = await saveBackupFileAs(result.record.archivo, bytes);
        if (saved) {
          await logEvent("INFO", `Backup descargado: ${result.record.archivo}`, user?.username ?? null);
        }
        setToastMessage(
          saved ? "Backup creado y guardado en la ubicación elegida." : "Backup creado y verificado con éxito.",
        );
      } else {
        setToastMessage("Backup creado y verificado con éxito.");
      }
      await refresh();
    } finally {
      setCreating(false);
    }
  }

  async function handleExportPreciosList() {
    if (exportingPrecios) return;
    setExportingPrecios(true);
    try {
      const precios = await getPreciosList();
      const bytes = buildPreciosListWorkbook(precios);
      const saved = await saveBackupFileAs("Lista de precios.xlsx", bytes);
      if (saved) {
        await logEvent("INFO", "Lista de precios exportada.", user?.username ?? null);
        setToastMessage("Lista de precios exportada.");
      }
    } finally {
      setExportingPrecios(false);
    }
  }

  async function handleExportRemisionesHistorial() {
    if (exportingRemisiones) return;
    setExportingRemisiones(true);
    try {
      const rows = await listRemisionRenglonesParaHistorial();
      const bytes = buildRemisionesHistorialWorkbook(rows);
      const saved = await saveBackupFileAs("Historial de remisiones.xlsx", bytes);
      if (saved) {
        await logEvent("INFO", "Historial de remisiones exportado.", user?.username ?? null);
        setToastMessage("Historial de remisiones exportado.");
      }
    } finally {
      setExportingRemisiones(false);
    }
  }

  async function handleDownload(record: BackupRecord) {
    if (!canDescargar) return;
    if (record.ubicacion.startsWith("http")) {
      await openUrl(record.ubicacion);
      setToastMessage("Se abrió el navegador — descarga el archivo desde ahí.");
      return;
    }
    const exists = await localBackupFileExists(record.ubicacion);
    if (!exists) {
      setToastMessage("El archivo local de este backup ya no está disponible en esta máquina.");
      return;
    }
    const bytes = await readLocalBackupFile(record.ubicacion);
    const saved = await saveBackupFileAs(record.archivo, bytes);
    if (saved) {
      await logEvent("INFO", `Backup descargado: ${record.archivo}`, user?.username ?? null);
      setToastMessage("Backup guardado.");
    }
  }

  async function handleDeleteConfirmed(record: BackupRecord) {
    if (!canEliminar || !token || !user) return;
    const isLatestValid = ultimoExitoso?.id === record.id;
    if (isLatestValid) {
      setToastMessage("No se puede eliminar el backup exitoso más reciente.");
      setConfirmDeleteId(null);
      return;
    }
    await deleteBackupRecord({ id: user.id, token }, record.id);
    await logEvent(
      "WARNING",
      `Backup eliminado: ${record.archivo} (${record.tipo})`,
      user?.username ?? null,
    );
    setConfirmDeleteId(null);
    await refresh();
  }

  async function loadRestoreCandidate(fileName: string, rawBytes: Uint8Array, matchedRecordId: number | null) {
    if (rawBytes.length === 0) {
      setRestoreFlow({
        status: "invalid",
        fileName,
        sql: "",
        validation: { ok: false, manifest: null, errors: ["El archivo está vacío."], statementCount: 0 },
        matchedRecordId,
        confirmText: "",
        message: "",
        sizeBytes: 0,
      });
      return;
    }
    if (rawBytes.length > MAX_RESTORE_FILE_BYTES) {
      setRestoreFlow({
        status: "invalid",
        fileName,
        sql: "",
        validation: {
          ok: false,
          manifest: null,
          errors: [`El archivo pesa ${formatBytes(rawBytes.length)}, mayor al límite permitido (${formatBytes(MAX_RESTORE_FILE_BYTES)}).`],
          statementCount: 0,
        },
        matchedRecordId,
        confirmText: "",
        message: "",
        sizeBytes: rawBytes.length,
      });
      return;
    }

    setRestoreFlow({
      status: "validating",
      fileName,
      sql: "",
      validation: null,
      matchedRecordId,
      confirmText: "",
      message: "",
      sizeBytes: rawBytes.length,
    });

    let sql: string;
    try {
      sql = isGzip(rawBytes) ? await gunzipToText(rawBytes) : new TextDecoder().decode(rawBytes);
    } catch (err) {
      setRestoreFlow({
        status: "invalid",
        fileName,
        sql: "",
        validation: { ok: false, manifest: null, errors: [`No se pudo leer el archivo: ${String(err)}`], statementCount: 0 },
        matchedRecordId,
        confirmText: "",
        message: "",
        sizeBytes: rawBytes.length,
      });
      return;
    }

    const validation = validateBackupSql(sql);
    let resolvedMatch = matchedRecordId;
    if (validation.ok && resolvedMatch === null) {
      const checksum = await sha256Hex(sql);
      const match = history.find((h) => h.estado === "EXITOSO" && h.checksum_sha256 === checksum);
      resolvedMatch = match?.id ?? null;
    }

    setRestoreFlow({
      status: validation.ok ? "ready" : "invalid",
      fileName,
      sql,
      validation,
      matchedRecordId: resolvedMatch,
      confirmText: "",
      message: "",
      sizeBytes: rawBytes.length,
    });
  }

  async function handleUploadRestoreFile() {
    if (!canRestaurar) return;
    const picked = await pickBackupFile();
    if (!picked) return;
    await loadRestoreCandidate(picked.name, picked.data, null);
  }

  async function handleRestoreFromHistory(record: BackupRecord) {
    if (!canRestaurar) return;
    if (record.ubicacion.startsWith("http")) {
      await openUrl(record.ubicacion);
      setToastMessage("Se abrió el navegador — descarga el archivo y usa \"Subir archivo de restauración\" para continuar.");
      return;
    }
    const exists = await localBackupFileExists(record.ubicacion);
    if (!exists) {
      setToastMessage("El archivo local de este backup ya no está disponible en esta máquina.");
      return;
    }
    const bytes = await readLocalBackupFile(record.ubicacion);
    await loadRestoreCandidate(record.archivo, bytes, record.id);
  }

  function cancelRestoreFlow() {
    setRestoreFlow(null);
  }

  async function confirmRestore() {
    if (!restoreFlow || restoreFlow.status !== "ready" || !restoreFlow.validation?.manifest) return;
    if (restoreFlow.confirmText.trim().toUpperCase() !== "RESTAURAR") return;
    if (!token || !user) return;

    setRestoreFlow({ ...restoreFlow, status: "running", message: "Creando backup de emergencia…" });
    const usuario = user?.username ?? null;

    const preRestore = await runBackupNow("BACKUP_PRE_RESTAURACION", `Antes de restaurar ${restoreFlow.fileName}`, usuario);
    if (!preRestore.ok) {
      setRestoreFlow({
        ...restoreFlow,
        status: "error",
        message: `No se pudo crear el backup de emergencia — la restauración se canceló. ${preRestore.errors.join("; ")}`,
      });
      await refresh();
      return;
    }

    setRestoreFlow((prev) => (prev ? { ...prev, message: "Restaurando…" } : prev));
    try {
      await executeRestoreSql({ id: user.id, token }, restoreFlow.sql);
    } catch (err) {
      setRestoreFlow({ ...restoreFlow, status: "error", message: `Falló la restauración: ${String(err)}` });
      await logEvent("ERROR", `Restauración fallida (${restoreFlow.fileName}): ${String(err)}`, usuario);
      await refresh();
      return;
    }

    setRestoreFlow((prev) => (prev ? { ...prev, message: "Verificando…" } : prev));
    const verification = await verifyRestoreCounts(restoreFlow.validation.manifest);

    const tipo: BackupTipo = restoreFlow.matchedRecordId ? "RESTAURACION" : "RESTAURACION_ARCHIVO_SUBIDO";
    const origen = restoreFlow.matchedRecordId
      ? `Backup #${restoreFlow.matchedRecordId} (${restoreFlow.fileName})`
      : `Archivo subido: ${restoreFlow.fileName}`;
    await createBackupRecord({
      tipo,
      origen,
      usuario,
      archivo: restoreFlow.fileName,
      ubicacion: "-",
      estado: verification.ok ? "EXITOSO" : "FALLIDO",
      detalle: verification.ok ? "" : verification.mismatches.join("; "),
    });
    await logEvent(
      verification.ok ? "INFO" : "ERROR",
      `${tipo}: ${origen} — ${verification.ok ? "verificado" : `discrepancias: ${verification.mismatches.join("; ")}`}`,
      usuario,
    );

    setRestoreFlow({
      ...restoreFlow,
      status: verification.ok ? "success" : "error",
      message: verification.ok
        ? "Restauración completada y verificada."
        : `Restauración completada con discrepancias: ${verification.mismatches.join("; ")}`,
    });
    await refresh();
  }

  function updateDraft<K extends keyof BackupSettings>(key: K, value: BackupSettings[K]) {
    setSettingsDirty(true);
    setSettingsDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function handleSaveSettings() {
    if (!settingsDraft || !canConfigurar || !token || !user) return;
    setSavingSettings(true);
    try {
      await updateBackupSettings(
        { id: user.id, token },
        {
          automatico_activado: settingsDraft.automatico_activado,
          frecuencia: settingsDraft.frecuencia,
          hora_ejecucion: settingsDraft.hora_ejecucion,
          intervalo_horas: settingsDraft.intervalo_horas,
          dia_semana: settingsDraft.dia_semana,
          retencion_diaria_dias: settingsDraft.retencion_diaria_dias,
          retencion_semanal_dias: settingsDraft.retencion_semanal_dias,
          retencion_mensual_dias: settingsDraft.retencion_mensual_dias,
        },
        user?.username ?? null,
      );
      await createBackupRecord({
        tipo: "CONFIGURACION_CAMBIADA",
        origen: "Programación de backups",
        usuario: user?.username ?? null,
        archivo: "-",
        ubicacion: "-",
        estado: "EXITOSO",
        detalle: `activado=${settingsDraft.automatico_activado}, frecuencia=${settingsDraft.frecuencia}, hora=${settingsDraft.hora_ejecucion}`,
      });
      await logEvent(
        "INFO",
        `Programación de backups actualizada por ${user?.username ?? "desconocido"}`,
        user?.username ?? null,
      );
      setToastMessage("Programación guardada.");
      await refresh();
    } finally {
      setSavingSettings(false);
    }
  }

  if (!canVer) {
    return <p className="hint">No tienes permiso para ver los backups.</p>;
  }

  if (loading || !settingsDraft) {
    return <p className="hint">Cargando…</p>;
  }

  const proximaEjecucion = computeNextRun(settingsDraft);

  return (
    <div className="backups-panel">
      <div className="backups-status-card">
        <h2>Respaldos de Clio</h2>
        <div className="backups-status-grid">
          <div>
            <span className="backups-status-label">Estado del sistema</span>
            <span>{estadoOk === null ? "—" : estadoOk ? "🟢 OK" : "🔴 Con errores"}</span>
          </div>
          <div>
            <span className="backups-status-label">Último backup</span>
            <span>{formatDateTime(ultimo?.creado_en ?? null)}</span>
          </div>
          <div>
            <span className="backups-status-label">Último backup exitoso</span>
            <span>{formatDateTime(ultimoExitoso?.creado_en ?? null)}</span>
          </div>
          <div>
            <span className="backups-status-label">Backups disponibles</span>
            <span>{history.length}</span>
          </div>
          <div>
            <span className="backups-status-label">Espacio local utilizado</span>
            <span>{formatBytes(espacioLocal)}</span>
          </div>
        </div>

        <div className="form-actions">
          {canCrear && (
            <button type="button" className="btn btn-primary" onClick={handleCreateManual} disabled={creating}>
              {creating ? "Creando backup…" : "Crear backup ahora"}
            </button>
          )}
          {canRestaurar && (
            <button type="button" className="btn btn-secondary" onClick={handleUploadRestoreFile}>
              Subir archivo de restauración
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleExportPreciosList}
            disabled={exportingPrecios}
          >
            {exportingPrecios ? "Generando…" : "Lista de precios"}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleExportRemisionesHistorial}
            disabled={exportingRemisiones}
          >
            {exportingRemisiones ? "Generando…" : "Historial de remisiones"}
          </button>
        </div>
      </div>

      {canConfigurar && (
        <div className="backups-settings-card">
          <h3>Programación</h3>
          <div className="form-row">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={settingsDraft.automatico_activado}
                onChange={(e) => updateDraft("automatico_activado", e.target.checked)}
              />
              Backup automático activado
            </label>
          </div>

          <div className="form-row">
            <label>
              Frecuencia
              <select
                value={settingsDraft.frecuencia}
                onChange={(e) => updateDraft("frecuencia", e.target.value as BackupFrecuencia)}
              >
                {Object.entries(FRECUENCIA_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            {settingsDraft.frecuencia === "cada_n_horas" && (
              <label>
                Cada cuántas horas
                <input
                  type="number"
                  min={1}
                  max={24}
                  value={settingsDraft.intervalo_horas ?? 6}
                  onChange={(e) => updateDraft("intervalo_horas", parseInt(e.target.value, 10) || 1)}
                />
              </label>
            )}

            {settingsDraft.frecuencia === "semanal" && (
              <label>
                Día de la semana
                <select
                  value={settingsDraft.dia_semana ?? 0}
                  onChange={(e) => updateDraft("dia_semana", parseInt(e.target.value, 10))}
                >
                  {DIAS_SEMANA.map((label, i) => (
                    <option key={i} value={i}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {settingsDraft.frecuencia !== "cada_n_horas" && (
              <label>
                Hora de ejecución
                <input
                  type="time"
                  value={settingsDraft.hora_ejecucion}
                  onChange={(e) => updateDraft("hora_ejecucion", e.target.value)}
                />
              </label>
            )}
          </div>

          <div className="form-row">
            <label>
              Retención diaria (días)
              <input
                type="number"
                min={1}
                value={settingsDraft.retencion_diaria_dias}
                onChange={(e) => updateDraft("retencion_diaria_dias", parseInt(e.target.value, 10) || 1)}
              />
            </label>
            <label>
              Retención semanal (días)
              <input
                type="number"
                min={1}
                value={settingsDraft.retencion_semanal_dias}
                onChange={(e) => updateDraft("retencion_semanal_dias", parseInt(e.target.value, 10) || 1)}
              />
            </label>
            <label>
              Retención mensual (días)
              <input
                type="number"
                min={1}
                value={settingsDraft.retencion_mensual_dias}
                onChange={(e) => updateDraft("retencion_mensual_dias", parseInt(e.target.value, 10) || 1)}
              />
            </label>
          </div>

          <p className="hint">
            Próxima ejecución:{" "}
            {proximaEjecucion ? formatDateTime(proximaEjecucion.toISOString()) : "Backup automático desactivado"}
          </p>

          <div className="form-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={savingSettings || !settingsDirty}
              onClick={handleSaveSettings}
            >
              {savingSettings ? "Guardando…" : "Guardar cambios"}
            </button>
          </div>
        </div>
      )}

      <div className="backups-history-card">
        <h3>Historial</h3>
        {history.length === 0 ? (
          <p className="hint">Aún no hay backups registrados.</p>
        ) : (
          <table className="backups-history-table">
            <tbody>
              {history.map((record) => (
                <tr key={record.id}>
                  <td>{formatDateTime(record.creado_en)}</td>
                  <td>{TIPO_LABELS[record.tipo] ?? record.tipo}</td>
                  <td>{record.usuario ?? "Sistema"}</td>
                  <td className={`backups-history-estado backups-history-estado-${record.estado.toLowerCase()}`}>
                    {record.estado === "EXITOSO" ? "✓" : record.estado === "FALLIDO" ? "✗" : "…"}
                  </td>
                  <td className="backups-history-actions">
                    {record.estado === "EXITOSO" && canRestaurar && (
                      <button type="button" className="btn-link" onClick={() => handleRestoreFromHistory(record)}>
                        Restaurar
                      </button>
                    )}
                    {record.estado === "EXITOSO" && canDescargar && record.archivo !== "-" && (
                      <button type="button" className="btn-link" onClick={() => handleDownload(record)}>
                        {record.ubicacion.startsWith("http") ? "Ver en GitHub" : "Descargar"}
                      </button>
                    )}
                    {canEliminar && record.archivo !== "-" && (
                      <>
                        {confirmDeleteId === record.id ? (
                          <span className="confirm-delete">
                            ¿Eliminar?
                            <button className="btn btn-danger" onClick={() => handleDeleteConfirmed(record)}>
                              Sí
                            </button>
                            <button className="btn-link" onClick={() => setConfirmDeleteId(null)}>
                              No
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="icon-btn icon-btn-remove"
                            onClick={() => setConfirmDeleteId(record.id)}
                            title="Eliminar backup"
                            aria-label="Eliminar backup"
                          >
                            <img src={basuraIcon} alt="" aria-hidden="true" />
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {restoreFlow && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h2>Restaurar backup</h2>
            <p>
              Archivo: <strong>{restoreFlow.fileName}</strong> ({formatBytes(restoreFlow.sizeBytes)})
            </p>

            {restoreFlow.status === "validating" && <p className="hint">Validando archivo…</p>}

            {restoreFlow.status === "invalid" && (
              <>
                <p className="form-error">El archivo no es un backup válido:</p>
                <ul>
                  {restoreFlow.validation?.errors.map((e, i) => (
                    <li key={i} className="form-error">
                      {e}
                    </li>
                  ))}
                </ul>
                <div className="form-actions">
                  <button type="button" className="btn btn-secondary" onClick={cancelRestoreFlow}>
                    Cerrar
                  </button>
                </div>
              </>
            )}

            {restoreFlow.status === "ready" && restoreFlow.validation?.manifest && (
              <>
                <p>Estado: Validado ✓</p>
                <ul>
                  {Object.entries(restoreFlow.validation.manifest.tablas).map(([table, count]) => (
                    <li key={table}>
                      {table}: {count} filas
                    </li>
                  ))}
                </ul>
                <p className="form-error">
                  ⚠️ Esta operación puede reemplazar información actual de producción. Antes de continuar se creará
                  un backup de emergencia del estado actual.
                </p>
                <label>
                  Escribe RESTAURAR para continuar
                  <input
                    type="text"
                    value={restoreFlow.confirmText}
                    onChange={(e) => setRestoreFlow({ ...restoreFlow, confirmText: e.target.value })}
                  />
                </label>
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={restoreFlow.confirmText.trim().toUpperCase() !== "RESTAURAR"}
                    onClick={confirmRestore}
                  >
                    Continuar
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={cancelRestoreFlow}>
                    Cancelar
                  </button>
                </div>
              </>
            )}

            {restoreFlow.status === "running" && <p className="hint">{restoreFlow.message}</p>}

            {(restoreFlow.status === "success" || restoreFlow.status === "error") && (
              <>
                <p className={restoreFlow.status === "success" ? "hint" : "form-error"}>{restoreFlow.message}</p>
                <div className="form-actions">
                  <button type="button" className="btn btn-primary" onClick={cancelRestoreFlow}>
                    Cerrar
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <Toast
        message={toastMessage ?? ""}
        show={!!toastMessage}
        onHide={() => setToastMessage(null)}
      />
    </div>
  );
}
