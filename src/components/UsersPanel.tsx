import { useEffect, useState, type FormEvent } from "react";
import { createUser, listUsers, updateUser, usernameEnUso } from "../db";
import { PERMISOS, PERMISO_LABELS } from "../types";
import type { Permiso, Rol, User } from "../types";
import Toast from "./Toast";

const MIN_PASSWORD_LENGTH = 4;

interface FormState {
  username: string;
  password: string;
  confirm: string;
  activo: boolean;
  rol: Rol;
  permisos: Permiso[];
}

const emptyForm: FormState = {
  username: "",
  password: "",
  confirm: "",
  activo: true,
  rol: "usuario",
  permisos: [],
};

export default function UsersPanel() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showToast, setShowToast] = useState(false);

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    const list = await listUsers();
    setUsers(list);
    setLoading(false);
  }

  function startNew() {
    setSelectedId(null);
    setForm(emptyForm);
    setError(null);
  }

  function selectUser(u: User) {
    setSelectedId(u.id);
    setForm({
      username: u.username,
      password: "",
      confirm: "",
      activo: u.activo,
      rol: u.rol,
      permisos: u.permisos,
    });
    setError(null);
  }

  function togglePermiso(permiso: Permiso) {
    setForm((prev) => ({
      ...prev,
      permisos: prev.permisos.includes(permiso)
        ? prev.permisos.filter((p) => p !== permiso)
        : [...prev.permisos, permiso],
    }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const username = form.username.trim();
    if (!username) {
      setError("El usuario es obligatorio.");
      return;
    }
    if (await usernameEnUso(username, selectedId ?? undefined)) {
      setError(`Ya existe un usuario "${username}".`);
      return;
    }

    const creating = selectedId === null;
    if (creating && form.password.length < MIN_PASSWORD_LENGTH) {
      setError(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
      return;
    }
    if (form.password && form.password.length < MIN_PASSWORD_LENGTH) {
      setError(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
      return;
    }
    if (form.password !== form.confirm) {
      setError("Las contraseñas no coinciden.");
      return;
    }

    const willBeActiveAdmin = form.rol === "admin" && form.activo;
    if (!willBeActiveAdmin && selectedId !== null) {
      const current = users.find((u) => u.id === selectedId);
      const wasActiveAdmin = current?.rol === "admin" && current.activo;
      const otherActiveAdmins = users.some(
        (u) => u.id !== selectedId && u.rol === "admin" && u.activo,
      );
      if (wasActiveAdmin && !otherActiveAdmins) {
        setError("Debe existir al menos un administrador activo.");
        return;
      }
    }

    setSaving(true);
    try {
      if (creating) {
        const id = await createUser({
          username,
          password: form.password,
          activo: form.activo,
          rol: form.rol,
          permisos: form.permisos,
        });
        await refresh();
        selectUser({ id, username, activo: form.activo, rol: form.rol, permisos: form.permisos, creado_en: "" });
      } else {
        await updateUser(selectedId, {
          username,
          password: form.password || undefined,
          activo: form.activo,
          rol: form.rol,
          permisos: form.permisos,
        });
        await refresh();
      }
      setForm((prev) => ({ ...prev, password: "", confirm: "" }));
      setShowToast(true);
    } catch (err) {
      setError(`No se pudo guardar: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="hint">Cargando…</p>;

  return (
    <div className="users-panel">
      <div className="users-list">
        <button type="button" className="btn btn-primary" onClick={startNew}>
          + Nuevo usuario
        </button>
        {users.map((u) => (
          <button
            key={u.id}
            type="button"
            className={`user-list-item${selectedId === u.id ? " user-list-item-active" : ""}`}
            onClick={() => selectUser(u)}
          >
            <span>{u.username}</span>
            <span className="tag">{u.rol === "admin" ? "Administrador" : "Usuario"}</span>
            {!u.activo && <span className="tag">Inactivo</span>}
          </button>
        ))}
      </div>

      <form className="user-form" onSubmit={handleSubmit}>
        <h2>{selectedId === null ? "Crear usuario" : `Editar: ${users.find((u) => u.id === selectedId)?.username}`}</h2>

        <div className="form-row">
          <label>
            Usuario
            <input
              type="text"
              value={form.username}
              onChange={(e) => setForm((p) => ({ ...p, username: e.target.value }))}
            />
          </label>
          <label>
            Rol
            <select
              value={form.rol}
              onChange={(e) => setForm((p) => ({ ...p, rol: e.target.value as Rol }))}
            >
              <option value="usuario">Usuario</option>
              <option value="admin">Administrador</option>
            </select>
          </label>
        </div>

        <div className="form-row">
          <label>
            {selectedId === null ? "Contraseña" : "Nueva contraseña (opcional)"}
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
            />
          </label>
          <label>
            Confirmar contraseña
            <input
              type="password"
              value={form.confirm}
              onChange={(e) => setForm((p) => ({ ...p, confirm: e.target.value }))}
            />
          </label>
        </div>

        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={form.activo}
            onChange={(e) => setForm((p) => ({ ...p, activo: e.target.checked }))}
          />
          Usuario activo
        </label>

        <div>
          <span className="hint" style={{ margin: 0 }}>Permisos</span>
          <div className="print-item-checks-grid" style={{ marginTop: "0.5rem" }}>
            <label className="checkbox-label">
              <input type="checkbox" checked disabled />
              Fichas Técnicas
            </label>
            {PERMISOS.map((permiso) => (
              <label className="checkbox-label" key={permiso}>
                <input
                  type="checkbox"
                  checked={form.rol === "admin" || form.permisos.includes(permiso)}
                  disabled={form.rol === "admin"}
                  onChange={() => togglePermiso(permiso)}
                />
                {PERMISO_LABELS[permiso]}
              </label>
            ))}
          </div>
          {form.rol === "admin" && (
            <p className="hint" style={{ marginTop: "0.5rem" }}>
              Los administradores tienen acceso completo automáticamente.
            </p>
          )}
        </div>

        {error && <p className="form-error">{error}</p>}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Guardando…" : selectedId === null ? "Crear usuario" : "Guardar cambios"}
          </button>
        </div>
      </form>

      <Toast message="Guardado con éxito" show={showToast} onHide={() => setShowToast(false)} />
    </div>
  );
}
