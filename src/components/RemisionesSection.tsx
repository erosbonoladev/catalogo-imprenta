import { useEffect, useMemo, useState } from "react";
import { hasPermission, useAuth } from "../auth";
import { deleteRemision, listRemisiones, logEventAsActor } from "../db";
import { formatMoney } from "../excelExport";
import type { Remision } from "../types";
import RemisionDetalleModal from "./RemisionDetalleModal";
import Pagination from "./Pagination";
import RemisionForm from "./RemisionForm";
import Toast from "./Toast";
import basuraIcon from "../../Assets/basura.svg";

type TipoSel = "interna" | "externa";

const PAGE_SIZE = 15;

function normalizeSearch(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function formatFechaCorta(fechaIso: string): string {
  const [y, m, d] = fechaIso.split("-");
  if (!y || !m || !d) return fechaIso;
  return `${d}/${m}/${y}`;
}

export default function RemisionesSection() {
  const { user, token } = useAuth();
  const allowed = hasPermission(user, "remisiones_acceso");
  const canCrear = hasPermission(user, "remisiones_crear");
  const canBorrar = hasPermission(user, "remisiones_cancelar");

  const [tipo, setTipo] = useState<TipoSel>("interna");
  const [recientes, setRecientes] = useState<Remision[]>([]);
  const [loadingRecientes, setLoadingRecientes] = useState(true);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [verRemision, setVerRemision] = useState<Remision | null>(null);
  const [query, setQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    if (!allowed) {
      if (user && token) {
        logEventAsActor({ id: user.id, token }, "WARNING", `Acceso denegado a Remisiones para ${user.username}`);
      }
      return;
    }
    refreshRecientes();
  }, [allowed, user, token]);

  async function refreshRecientes() {
    if (!user || !token) return;
    setLoadingRecientes(true);
    const list = await listRemisiones({ id: user.id, token });
    setRecientes(list);
    setLoadingRecientes(false);
  }

  const filtradas = useMemo(() => {
    const q = normalizeSearch(query);
    if (!q) return recientes;
    return recientes.filter((r) =>
      normalizeSearch(`${r.folio} ${r.pedido_bodegas} ${r.fecha} ${formatFechaCorta(r.fecha)}`).includes(q),
    );
  }, [recientes, query]);

  const totalPages = Math.max(1, Math.ceil(filtradas.length / PAGE_SIZE));

  useEffect(() => {
    setCurrentPage((page) => Math.min(page, totalPages));
  }, [totalPages]);

  if (!allowed) {
    return (
      <div className="private-section">
        <h1>Acceso denegado</h1>
        <p className="hint">No tienes permiso para ver esta sección.</p>
      </div>
    );
  }

  async function handleBorrar(id: number) {
    if (!user || !token) return;
    await deleteRemision({ id: user.id, token }, id);
    setConfirmDeleteId(null);
    setToastMessage("Remisión eliminada.");
    await refreshRecientes();
  }

  return (
    <div className="private-section">
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
            <h2>Historial de remisiones</h2>
            <input
              className="search-input"
              type="text"
              placeholder="Buscar por folio, bodega o fecha (dd/mm/aaaa)…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCurrentPage(1);
              }}
            />
            {loadingRecientes ? (
              <p className="hint">Cargando…</p>
            ) : recientes.length === 0 ? (
              <p className="hint">Aún no hay remisiones.</p>
            ) : filtradas.length === 0 ? (
              <p className="hint">Sin resultados para esa búsqueda.</p>
            ) : (
              <table className="backups-history-table">
                <tbody>
                  {filtradas.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE).map((r) => (
                    <tr key={r.id}>
                      <td>{r.folio}</td>
                      <td>{formatFechaCorta(r.fecha)}</td>
                      <td>{r.pedido_bodegas || "Sin bodega"}</td>
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
                              className="icon-btn icon-btn-remove"
                              onClick={() => setConfirmDeleteId(r.id)}
                              title="Borrar remisión"
                              aria-label="Borrar remisión"
                            >
                              <img src={basuraIcon} alt="" aria-hidden="true" />
                            </button>
                          ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {!loadingRecientes && totalPages > 1 && (
              <Pagination currentPage={currentPage} totalPages={totalPages} onChange={setCurrentPage} />
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
