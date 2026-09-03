import { useEffect, useState, type FormEvent } from "react";
import { createUser, listUsers, updateUser, usernameEnUso } from "../db";
import { PERMISOS, PERMISO_LABELS } from "../types";
import type { Permiso, Rol, User } from "../types";
import { isAdmin, useAuth } from "../auth";
import Toast from "./Toast";

const MIN_PASSWORD_LENGTH = 8;
const PASSWORD_COMPLEXITY_RE = /(?=.*[A-Za-z])(?=.*\d)/;
const PASSWORD_HINT = `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres e incluir letras y números.`;

interface FormState {
  username: string;
  password: string;
  confirm: string;
  activo: boolean;
  rol: Rol;
  permisos: Permiso[];
  backup_local_diario: boolean;
}

const emptyForm: FormState = {
  username: "",
  password: "",
  confirm: "",
  activo: true,
  rol: "usuario",
  permisos: [],
  backup_local_diario: false,
};

export default function UsersPanel() {
  const { user: actingUser, token } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const allowed = isAdmin(actingUser);

  useEffect(() => {
    // No disparar listUsers() (usernames/roles/permisos de todo el mundo) si
    // igual se va a mostrar "Acceso denegado" — el gate de abajo bloquea la
    // vista, pero por sí solo no evita que este efecto ya haya traído los
    // datos a memoria.
    if (allowed) refresh();
  }, [allowed]);

  // Administrar usuarios y permisos (incluida la posibilidad de otorgarse
  // rol admin) es más sensible que el resto de Configuraciones — antes vivía
  // bajo el permiso general "configuraciones", que cualquier persona con
  // acceso a Logs/Conectados también podía tener. Se re-chequea acá, no solo
  // ocultando la pestaña en Configuraciones.tsx.
  if (!allowed) {
    return (
      <div>
        <h2>Acceso denegado</h2>
        <p className="hint">Administrar usuarios requiere una cuenta administradora.</p>
      </div>
    );
  }

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
      backup_local_diario: u.backup_local_diario,
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
    if (creating || form.password) {
      if (
        form.password.length < MIN_PASSWORD_LENGTH ||
        !PASSWORD_COMPLEXITY_RE.test(form.password)
      ) {
        setError(PASSWORD_HINT);
        return;
      }
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

    if (!token || !actingUser) {
      setError("Tu sesión ya no es válida — vuelve a iniciar sesión.");
      return;
    }

    setSaving(true);
    try {
      const actor = { id: actingUser.id, token };
      if (creating) {
        const id = await createUser(actor, {
          username,
          password: form.password,
          activo: form.activo,
          rol: form.rol,
          permisos: form.permisos,
          backup_local_diario: form.backup_local_diario,
        });
        await refresh();
        selectUser({
          id,
          username,
          activo: form.activo,
          rol: form.rol,
          permisos: form.permisos,
          backup_local_diario: form.backup_local_diario,
          creado_en: "",
        });
      } else {
        await updateUser(actor, selectedId, {
          username,
          password: form.password || undefined,
          activo: form.activo,
          rol: form.rol,
          permisos: form.permisos,
          backup_local_diario: form.backup_local_diario,
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
            <span className="hint">{PASSWORD_HINT}</span>
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

        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={form.backup_local_diario}
            onChange={(e) => setForm((p) => ({ ...p, backup_local_diario: e.target.checked }))}
          />
          Backup local diario al entrar a la app
        </label>
        <p className="hint" style={{ marginTop: 0 }}>
          Al entrar a Clio, se genera como máximo un backup por día en la computadora donde esta persona use la app —
          se le pedirá elegir dónde guardarlo (carpeta, USB, etc.).
        </p>

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
