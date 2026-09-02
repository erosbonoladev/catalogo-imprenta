import { useEffect, useState } from "react";
import { hasPermission, useAuth } from "../auth";
import { deleteRemision, listRemisiones, logEvent } from "../db";
import { formatMoney } from "../excelExport";
import type { Remision } from "../types";
import RemisionDetalleModal from "./RemisionDetalleModal";
import RemisionForm from "./RemisionForm";
import Toast from "./Toast";

interface Props {
  onBack: () => void;
}

type TipoSel = "interna" | "externa";

function formatFechaCorta(fechaIso: string): string {
  const [y, m, d] = fechaIso.split("-");
  if (!y || !m || !d) return fechaIso;
  return `${d}/${m}/${y}`;
}

export default function RemisionesSection({ onBack }: Props) {
  const { user } = useAuth();
  const allowed = hasPermission(user, "remisiones_acceso");
  const canCrear = hasPermission(user, "remisiones_crear");
  const canBorrar = hasPermission(user, "remisiones_cancelar");

  const [tipo, setTipo] = useState<TipoSel>("interna");
  const [recientes, setRecientes] = useState<Remision[]>([]);
  const [loadingRecientes, setLoadingRecientes] = useState(true);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [verRemision, setVerRemision] = useState<Remision | null>(null);

  useEffect(() => {
    if (!allowed) {
      logEvent(
        "WARNING",
        `Acceso denegado a Remisiones para ${user?.username ?? "desconocido"}`,
        user?.username ?? null,
      );
      return;
    }
    refreshRecientes();
  }, [allowed]);

  async function refreshRecientes() {
    setLoadingRecientes(true);
    const list = await listRemisiones(30);
    setRecientes(list);
    setLoadingRecientes(false);
  }

  if (!allowed) {
    return (
      <div className="private-section">
        <button className="btn-link" onClick={onBack}>
          ← Volver al menú principal
        </button>
        <h1>Acceso denegado</h1>
        <p className="hint">No tienes permiso para ver esta sección.</p>
      </div>
    );
  }

  async function handleBorrar(id: number) {
    await deleteRemision(id, user?.username ?? null);
    setConfirmDeleteId(null);
    setToastMessage("Remisión eliminada.");
    await refreshRecientes();
  }

  return (
    <div className="private-section">
      <button className="btn-link" onClick={onBack}>
        ← Volver al menú principal
      </button>
      <h1>Remisiones</h1>

      <div className="search-filters" role="group" aria-label="Tipo de remisión">
        <button
          type="button"
          className={`filter-chip${tipo === "interna" ? " filter-chip-active" : ""}`}
          onClick={() => setTipo("interna")}
        >
          Interna
        </button>
        <button
          type="button"
          className="filter-chip"
          disabled
          title="Próximamente"
          aria-disabled="true"
        >
          Externa (Próximamente)
        </button>
      </div>

      {tipo === "interna" && (
        <>
          {canCrear ? (
            <RemisionForm onCreated={refreshRecientes} />
          ) : (
            <p className="hint">No tienes permiso para crear remisiones.</p>
          )}

          <div className="remisiones-recientes">
            <h2>Remisiones recientes</h2>
            {loadingRecientes ? (
              <p className="hint">Cargando…</p>
            ) : recientes.length === 0 ? (
              <p className="hint">Aún no hay remisiones.</p>
            ) : (
              <table className="backups-history-table">
                <tbody>
                  {recientes.map((r) => (
                    <tr key={r.id}>
                      <td>{r.folio}</td>
                      <td>{formatFechaCorta(r.fecha)}</td>
                      <td>{formatMoney(r.total)}</td>
                      <td>{r.cancelada ? "Cancelada" : "Activa"}</td>
                      <td className="backups-history-actions">
                        <button type="button" className="btn-link" onClick={() => setVerRemision(r)}>
                          Ver
                        </button>
                        {canBorrar &&
                          (confirmDeleteId === r.id ? (
                            <span className="confirm-delete">
                              ¿Borrar?
                              <button className="btn btn-danger" onClick={() => handleBorrar(r.id)}>
                                Sí
                              </button>
                              <button className="btn-link" onClick={() => setConfirmDeleteId(null)}>
                                No
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="btn-link"
                              onClick={() => setConfirmDeleteId(r.id)}
                            >
                              Borrar
                            </button>
                          ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {tipo === "externa" && <p className="hint">Remisión externa — próximamente.</p>}

      <Toast message={toastMessage ?? ""} show={!!toastMessage} onHide={() => setToastMessage(null)} />

      {verRemision && (
        <RemisionDetalleModal
          remision={verRemision}
          onClose={() => setVerRemision(null)}
          onUpdated={refreshRecientes}
        />
      )}
    </div>
  );
}
