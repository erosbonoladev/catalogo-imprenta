import { useEffect, useState } from "react";
import {
  createPlasticProduct,
  deletePlasticProduct,
  getImageSrc,
  logEvent,
  pickImage,
  searchPlasticProducts,
  updatePlasticProduct,
} from "../db";
import type { PlasticProduct, PlasticProductInput } from "../types";
import { hasPermission, useAuth } from "../auth";
import AutoGrowInput from "./AutoGrowInput";
import Toast from "./Toast";
import PlasticProductFields, { EMPTY_PLASTIC_DATA } from "./PlasticProductFields";
import basuraIcon from "../../Assets/basura.svg";

interface Props {
  onBack: () => void;
  onVerPieza: (plasticProductId: number) => void;
}

export default function PiezasGeneralSection({ onBack, onVerPieza }: Props) {
  const { user } = useAuth();
  const allowed = hasPermission(user, "plasticos");
  const [piezas, setPiezas] = useState<PlasticProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<PlasticProduct | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  async function refresh() {
    const list = await searchPlasticProducts("");
    setPiezas(list);
    setLoading(false);
  }

  useEffect(() => {
    if (!allowed) return;
    refresh();
  }, [allowed]);

  useEffect(() => {
    if (allowed) return;
    logEvent(
      "WARNING",
      `Acceso denegado a Piezas General para ${user?.username ?? "desconocido"}`,
      user?.username ?? null,
    );
  }, [allowed, user?.username]);

  if (!allowed) {
    return (
      <div className="private-section">
        <button className="btn-link" onClick={onBack}>
          ← Volver
        </button>
        <h1>Acceso denegado</h1>
        <p className="hint">No tienes permiso para ver esta sección.</p>
      </div>
    );
  }

  async function handleBorrar(id: number) {
    setDeleting(true);
    try {
      await deletePlasticProduct(id);
      setConfirmDeleteId(null);
      await refresh();
      setToastMessage("Pieza eliminada.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="private-section">
      <button className="btn-link" onClick={onBack}>
        ← Volver
      </button>
      <h1>Piezas General</h1>
      <p className="hint">
        Catálogo completo de piezas registradas en la base de datos, estén o no vinculadas
        actualmente a una ficha técnica.
      </p>

      <div className="form-actions" style={{ margin: "1.1rem 0" }}>
        <button type="button" className="btn btn-primary" onClick={() => setShowForm(true)}>
          + Agregar nueva pieza
        </button>
      </div>

      {loading ? (
        <p className="hint">Cargando…</p>
      ) : piezas.length === 0 ? (
        <p className="hint">No hay piezas registradas.</p>
      ) : (
        <div className="import-review-table-wrap">
          <table className="import-review-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Nombre de la pieza</th>
                <th>Material</th>
                <th>Color</th>
                <th>Origen</th>
                <th>Dimensión</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {piezas.map((p) => (
                <tr key={p.id}>
                  <td>{p.sku || "—"}</td>
                  <td>{p.nombre || "(sin nombre)"}</td>
                  <td>{p.material || "—"}</td>
                  <td>{p.color || "—"}</td>
                  <td>{p.origen || "—"}</td>
                  <td>{p.dimension || "—"}</td>
                  <td className="backups-history-actions">
                    <button type="button" className="btn-link" onClick={() => onVerPieza(p.id)}>
                      Ver especificaciones
                    </button>
                    <button type="button" className="btn-link" onClick={() => setEditing(p)}>
                      Editar
                    </button>
                    {confirmDeleteId === p.id ? (
                      <span className="confirm-delete">
                        ¿Borrar?
                        <button
                          type="button"
                          className="btn btn-danger"
                          onClick={() => handleBorrar(p.id)}
                          disabled={deleting}
                        >
                          Sí
                        </button>
                        <button
                          type="button"
                          className="btn-link"
                          onClick={() => setConfirmDeleteId(null)}
                          disabled={deleting}
                        >
                          No
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="icon-btn icon-btn-remove"
                        onClick={() => setConfirmDeleteId(p.id)}
                        title="Borrar pieza"
                        aria-label="Borrar pieza"
                      >
                        <img src={basuraIcon} alt="" aria-hidden="true" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <PiezaFormModal
          onClose={() => setShowForm(false)}
          onSaved={async () => {
            setShowForm(false);
            await refresh();
            setToastMessage("Pieza agregada.");
          }}
        />
      )}

      {editing && (
        <PiezaFormModal
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
            setToastMessage("Pieza actualizada.");
          }}
        />
      )}

      <Toast message={toastMessage ?? ""} show={!!toastMessage} onHide={() => setToastMessage(null)} />
    </div>
  );
}

export interface PiezaFormModalProps {
  existing?: PlasticProduct;
  onClose: () => void;
  onSaved: () => void;
}

export function PiezaFormModal({ existing, onClose, onSaved }: PiezaFormModalProps) {
  const [data, setData] = useState<PlasticProductInput>(() =>
    existing
      ? {
          nombre: existing.nombre,
          sku: existing.sku,
          color: existing.color,
          origen: existing.origen,
          descripcion: existing.descripcion,
          material: existing.material,
          dimension: existing.dimension,
          peso: existing.peso,
          tipo_empaque: existing.tipo_empaque,
          maquila: existing.maquila,
          coste: existing.coste,
          imagen: existing.imagen,
        }
      : { ...EMPTY_PLASTIC_DATA },
  );
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getImageSrc(data.imagen).then((src) => {
      if (!cancelled) setImageSrc(src);
    });
    return () => {
      cancelled = true;
    };
  }, [data.imagen]);

  function update(patch: Partial<PlasticProductInput>) {
    setData((prev) => ({ ...prev, ...patch }));
  }

  async function pickProductImage() {
    const image = await pickImage();
    if (image) update({ imagen: image });
  }

  async function handleSave() {
    const nombre = data.nombre.trim();
    if (!nombre) {
      setError("El nombre de la pieza es obligatorio.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (existing) {
        await updatePlasticProduct(existing.id, { ...data, nombre });
      } else {
        await createPlasticProduct({ ...data, nombre });
      }
      onSaved();
    } catch (err) {
      setError(`No se pudo guardar la pieza: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        <h2>{existing ? "Editar pieza" : "Agregar nueva pieza"}</h2>

        <label className="plastic-item-field" style={{ marginBottom: "0.9rem" }}>
          <span>Nombre de la pieza</span>
          <AutoGrowInput
            placeholder="Nombre"
            value={data.nombre}
            onChange={(v) => update({ nombre: v })}
          />
        </label>

        <div className="plastic-item-layout">
          <PlasticProductFields
            data={data}
            imageSrc={imageSrc}
            onChange={update}
            onPickImage={pickProductImage}
          />
        </div>

        {error && <p className="form-error">{error}</p>}

        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "Guardando…" : existing ? "Guardar cambios" : "Guardar pieza"}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
