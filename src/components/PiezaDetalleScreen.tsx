import { useEffect, useState } from "react";
import {
  deletePlasticProduct,
  getImageSrc,
  getPlasticProduct,
  getProductsUsingPlasticProduct,
  logEvent,
  type ProductUsingPlasticRow,
} from "../db";
import type { PlasticProduct } from "../types";
import { hasPermission, useAuth } from "../auth";
import { PiezaFormModal } from "./PiezasGeneralSection";
import Toast from "./Toast";
import basuraIcon from "../../Assets/basura.svg";

interface Props {
  plasticProductId: number;
  onBack: () => void;
  onOpenProduct: (productId: number) => void;
}

const CAMPOS: { label: string; key: keyof PlasticProduct }[] = [
  { label: "SKU", key: "sku" },
  { label: "Material", key: "material" },
  { label: "Color", key: "color" },
  { label: "Origen", key: "origen" },
  { label: "Dimensión", key: "dimension" },
  { label: "Peso", key: "peso" },
  { label: "Tipo de empaque", key: "tipo_empaque" },
  { label: "Maquila", key: "maquila" },
  { label: "Coste", key: "coste" },
];

export default function PiezaDetalleScreen({ plasticProductId, onBack, onOpenProduct }: Props) {
  const { user, token } = useAuth();
  const allowed = hasPermission(user, "plasticos");
  const [pieza, setPieza] = useState<PlasticProduct | null>(null);
  const [usedIn, setUsedIn] = useState<ProductUsingPlasticRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    const [data, usage] = await Promise.all([
      getPlasticProduct(plasticProductId),
      getProductsUsingPlasticProduct(plasticProductId),
    ]);
    setPieza(data);
    setUsedIn(usage);
    setLoading(false);
  }

  useEffect(() => {
    if (!allowed) return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, plasticProductId]);

  useEffect(() => {
    if (allowed) return;
    logEvent(
      "WARNING",
      `Acceso denegado a detalle de Pieza para ${user?.username ?? "desconocido"}`,
      user?.username ?? null,
    );
  }, [allowed, user?.username]);

  useEffect(() => {
    let cancelled = false;
    getImageSrc(pieza?.imagen ?? null).then((src) => {
      if (!cancelled) setImageSrc(src);
    });
    return () => {
      cancelled = true;
    };
  }, [pieza?.imagen]);

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

  async function handleBorrar() {
    if (!user || !token) return;
    setDeleting(true);
    try {
      await deletePlasticProduct({ id: user.id, token }, plasticProductId);
      onBack();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="private-section">
      <button className="btn-link" onClick={onBack}>
        ← Volver a Piezas General
      </button>

      {loading ? (
        <p className="hint">Cargando…</p>
      ) : !pieza ? (
        <>
          <h1>Pieza no encontrada</h1>
          <p className="hint">Es posible que ya haya sido eliminada del catálogo.</p>
        </>
      ) : (
        <>
          <h1>{pieza.nombre || "(sin nombre)"}</h1>
          <p className="hint">Especificaciones completas de la pieza en el catálogo maestro.</p>

          <div className="plastic-item-layout">
            <div className="plastic-item-media-col">
              <div className="plastic-item-image-box">
                {imageSrc ? (
                  <img src={imageSrc} alt={pieza.nombre || "Pieza"} />
                ) : (
                  <span className="product-card-placeholder">Sin imagen</span>
                )}
              </div>
            </div>

            <div className="plastic-item-view-fields">
              {CAMPOS.map((campo) => (
                <div className="plastic-item-view-field" key={campo.key}>
                  <span className="plastic-item-view-field-label">{campo.label}</span>
                  <span className="plastic-item-view-field-value">
                    {(pieza[campo.key] as string) || "—"}
                  </span>
                </div>
              ))}
              {pieza.descripcion && (
                <div className="plastic-item-view-field">
                  <span className="plastic-item-view-field-label">Descripción</span>
                  <span className="plastic-item-view-field-value">{pieza.descripcion}</span>
                </div>
              )}
              <div className="plastic-item-view-field">
                <span className="plastic-item-view-field-label">Creado</span>
                <span className="plastic-item-view-field-value">{pieza.creado_en}</span>
              </div>
            </div>
          </div>

          <h2>Usado en fichas técnicas</h2>
          {usedIn.length === 0 ? (
            <p className="hint">Esta pieza no está vinculada a ninguna ficha técnica todavía.</p>
          ) : (
            <div className="plastic-picker-results">
              {usedIn.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className="btn-link"
                  style={{ textAlign: "left" }}
                  onClick={() => onOpenProduct(p.id)}
                >
                  {p.codigo} — {p.nombre}
                </button>
              ))}
            </div>
          )}

          <div className="form-actions" style={{ margin: "1.1rem 0" }}>
            <button type="button" className="btn btn-primary" onClick={() => setEditing(true)}>
              Editar pieza
            </button>
            {confirmDelete ? (
              <span className="confirm-delete">
                ¿Borrar esta pieza
                {usedIn.length > 0 ? ` y quitarla de ${usedIn.length} ficha(s) técnica(s)` : ""}?
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={handleBorrar}
                  disabled={deleting}
                >
                  Sí, borrar
                </button>
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => setConfirmDelete(false)}
                  disabled={deleting}
                >
                  Cancelar
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="icon-btn icon-btn-remove"
                onClick={() => setConfirmDelete(true)}
                title="Borrar pieza"
                aria-label="Borrar pieza"
              >
                <img src={basuraIcon} alt="" aria-hidden="true" />
              </button>
            )}
          </div>
        </>
      )}

      {editing && pieza && (
        <PiezaFormModal
          existing={pieza}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await refresh();
            setToastMessage("Pieza actualizada.");
          }}
        />
      )}

      <Toast message={toastMessage ?? ""} show={!!toastMessage} onHide={() => setToastMessage(null)} />
    </div>
  );
}
