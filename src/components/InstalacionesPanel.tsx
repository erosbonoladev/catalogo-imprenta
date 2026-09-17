import { useEffect, useState, type FormEvent } from "react";
import { hasPermission, useAuth } from "../auth";
import {
  crearCredencial,
  listInstalaciones,
  reactivarInstalacion,
  revocarInstalacion,
  type Actor,
} from "../activation";
import type { Instalacion, InstalacionCredencialCreada } from "../types";
import Toast from "./Toast";

interface CredentialFormState {
  sede_codigo: string;
  sede_nombre: string;
  descripcion: string;
  usuario_responsable: string;
}

const emptyForm: CredentialFormState = {
  sede_codigo: "",
  sede_nombre: "",
  descripcion: "",
  usuario_responsable: "",
};

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value.replace(" ", "T") + "Z");
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });
}

// Mismo esqueleto de layout que UsersPanel (lista + panel de detalle/form) —
// misma clase de sensibilidad: quién puede administrar instalaciones/
// credenciales de activación controla quién puede correr copias de CLIO
// (ver docs/PERMISSIONS.md).
export default function InstalacionesPanel() {
  const { user, token } = useAuth();
  const canVer = hasPermission(user, "instalaciones_ver");
  const canCrear = hasPermission(user, "instalaciones_crear_credenciales");
  const canRevocar = hasPermission(user, "instalaciones_revocar");
  const canReactivar = hasPermission(user, "instalaciones_reactivar");
  const canAlgo = canVer || canCrear || canRevocar || canReactivar;

  const [installations, setInstallations] = useState<Instalacion[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [form, setForm] = useState<CredentialFormState>(emptyForm);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createdCredential, setCreatedCredential] = useState<InstalacionCredencialCreada | null>(null);
  const [confirmAction, setConfirmAction] = useState<"revoke" | "reactivate" | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  useEffect(() => {
    if (canVer) refresh();
    else setLoading(false);
  }, [canVer]);

  if (!canAlgo) {
    return <p className="hint">No tienes permiso para administrar instalaciones.</p>;
  }

  function actor(): Actor | null {
    if (!user || !token) return null;
    return { id: user.id, token };
  }

  async function refresh() {
    const a = actor();
    if (!a) return;
    try {
      const list = await listInstalaciones(a);
      setInstallations(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function startCreate() {
    setSelectedId(null);
    setCreatingNew(true);
    setForm(emptyForm);
    setCreateError(null);
    setCreatedCredential(null);
  }

  function selectInstallation(installation: Instalacion) {
    setSelectedId(installation.id);
    setCreatingNew(false);
    setConfirmAction(null);
  }

  async function handleCreateCredential(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    const a = actor();
    if (!a) {
      setCreateError("Tu sesión ya no es válida — vuelve a iniciar sesión.");
      return;
    }
    if (!form.sede_codigo.trim() || !form.sede_nombre.trim()) {
      setCreateError("Sede (código y nombre) es obligatoria.");
      return;
    }
    setCreating(true);
    try {
      const result = await crearCredencial(a, form);
      setCreatedCredential(result);
      setForm(emptyForm);
      await refresh();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(installation: Instalacion) {
    const a = actor();
    if (!a) return;
    setActionBusy(true);
    try {
      await revocarInstalacion(a, installation.id);
      setToastMessage(`Instalación ${installation.installation_code} revocada.`);
      await refresh();
    } catch (err) {
      setToastMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
      setConfirmAction(null);
    }
  }

  async function handleReactivate(installation: Instalacion) {
    const a = actor();
    if (!a) return;
    setActionBusy(true);
    try {
      await reactivarInstalacion(a, installation.id);
      setToastMessage(`Instalación ${installation.installation_code} reactivada.`);
      await refresh();
    } catch (err) {
      setToastMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
      setConfirmAction(null);
    }
  }

  const selected = installations.find((i) => i.id === selectedId) ?? null;

  if (loading) return <p className="hint">Cargando…</p>;

  return (
    <div className="users-panel">
      <div className="users-list">
        {canCrear && (
          <button type="button" className="btn btn-primary" onClick={startCreate}>
            + Crear credencial
          </button>
        )}
        {loadError && <p className="form-error">{loadError}</p>}
        {canVer &&
          installations.map((installation) => (
            <button
              key={installation.id}
              type="button"
              className={`user-list-item${selectedId === installation.id ? " user-list-item-active" : ""}`}
              onClick={() => selectInstallation(installation)}
            >
              <span>{installation.installation_code}</span>
              <span className="tag">{installation.sede_nombre}</span>
              {installation.estado === "revocada" && <span className="tag">Revocada</span>}
            </button>
          ))}
        {canVer && installations.length === 0 && !loadError && (
          <p className="hint">Todavía no hay instalaciones activadas.</p>
        )}
      </div>

      {creatingNew && canCrear && (
        <form className="user-form" onSubmit={handleCreateCredential}>
          <h2>Crear credencial de activación</h2>

          {createdCredential ? (
            <>
              <p className="hint">
                Copia este código ahora — no se puede volver a mostrar completo después. Entrégalo a la
                sede correspondiente para que lo use en "Activar instalación".
              </p>
              <label>
                Código de activación
                <input
                  type="text"
                  readOnly
                  value={createdCredential.codigo}
                  onFocus={(e) => e.currentTarget.select()}
                />
              </label>
              <div className="form-actions">
                <button type="button" className="btn btn-primary" onClick={startCreate}>
                  Crear otra credencial
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="form-row">
                <label>
                  Código de sede
                  <input
                    type="text"
                    value={form.sede_codigo}
                    onChange={(e) => setForm((p) => ({ ...p, sede_codigo: e.target.value.toUpperCase() }))}
                    placeholder="PUE"
                  />
                </label>
                <label>
                  Nombre de sede
                  <input
                    type="text"
                    value={form.sede_nombre}
                    onChange={(e) => setForm((p) => ({ ...p, sede_nombre: e.target.value }))}
                    placeholder="Puebla"
                  />
                </label>
              </div>
              <label>
                Nombre / descripción
                <input
                  type="text"
                  value={form.descripcion}
                  onChange={(e) => setForm((p) => ({ ...p, descripcion: e.target.value }))}
                  placeholder="Equipo de mostrador"
                />
              </label>
              <label>
                Usuario responsable (opcional)
                <input
                  type="text"
                  value={form.usuario_responsable}
                  onChange={(e) => setForm((p) => ({ ...p, usuario_responsable: e.target.value }))}
                />
              </label>

              {createError && <p className="form-error">{createError}</p>}

              <div className="form-actions">
                <button type="submit" className="btn btn-primary" disabled={creating}>
                  {creating ? "Generando…" : "Generar credencial"}
                </button>
              </div>
            </>
          )}
        </form>
      )}

      {selected && !creatingNew && (
        <div className="user-form">
          <h2>{selected.installation_code}</h2>
          <p className="hint">
            {selected.sede_nombre}
            {selected.descripcion ? ` — ${selected.descripcion}` : ""}
          </p>

          <div className="form-row">
            <label>
              Estado
              <input type="text" readOnly value={selected.estado === "activa" ? "Activa" : "Revocada"} />
            </label>
            <label>
              Versión
              <input type="text" readOnly value={selected.ultima_version ?? "—"} />
            </label>
          </div>
          <div className="form-row">
            <label>
              Activada
              <input type="text" readOnly value={formatDateTime(selected.activada_en)} />
            </label>
            <label>
              Última conexión
              <input type="text" readOnly value={formatDateTime(selected.ultima_conexion_en)} />
            </label>
          </div>

          {confirmAction ? (
            <span className="confirm-delete">
              {confirmAction === "revoke" ? "¿Revocar esta instalación?" : "¿Reactivar esta instalación?"}
              <button
                type="button"
                className="btn btn-danger"
                disabled={actionBusy}
                onClick={() => (confirmAction === "revoke" ? handleRevoke(selected) : handleReactivate(selected))}
              >
                Sí
              </button>
              <button type="button" className="btn-link" disabled={actionBusy} onClick={() => setConfirmAction(null)}>
                No
              </button>
            </span>
          ) : (
            <div className="form-actions">
              {selected.estado === "activa" && canRevocar && (
                <button type="button" className="btn btn-danger" onClick={() => setConfirmAction("revoke")}>
                  Revocar instalación
                </button>
              )}
              {selected.estado === "revocada" && canReactivar && (
                <button type="button" className="btn btn-primary" onClick={() => setConfirmAction("reactivate")}>
                  Reactivar instalación
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <Toast message={toastMessage ?? ""} show={!!toastMessage} onHide={() => setToastMessage(null)} />
    </div>
  );
}
