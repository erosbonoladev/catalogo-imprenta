import { useState } from "react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { allowFsPath, createRequisicionConFolio, logEvent } from "../db";
import { buildRequisicionPdf } from "../pdf";
import { buildWhatsAppUrl, WHATSAPP_BODEGA_NUMBER } from "../requisiciones";
import type { Product, Requisicion } from "../types";
import { useAuth } from "../auth";

interface Props {
  product: Product;
  etiqueta: string;
  descripcion: string;
  onClose: () => void;
}

const NUMERIC_RE = /^\d+(\.\d+)?$/;

export default function RequisicionModal({
  product,
  etiqueta,
  descripcion,
  onClose,
}: Props) {
  const { user } = useAuth();
  const [cantidad, setCantidad] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultado, setResultado] = useState<Requisicion | null>(null);

  async function handleGenerar() {
    setError(null);
    const trimmed = cantidad.trim();
    if (!trimmed) {
      setError("La cantidad es obligatoria.");
      return;
    }
    if (!NUMERIC_RE.test(trimmed)) {
      setError("Ingresa una cantidad numérica válida.");
      return;
    }
    const cantidadNum = parseFloat(trimmed);
    if (!(cantidadNum > 0)) {
      setError("La cantidad debe ser mayor que 0.");
      return;
    }
    if (!WHATSAPP_BODEGA_NUMBER) {
      setError(
        "No hay un número de WhatsApp de bodega configurado (VITE_WHATSAPP_BODEGA_NUMBER).",
      );
      return;
    }

    setSaving(true);
    try {
      // Folio + requisición se generan juntos en una sola transacción (ver
      // createRequisicionConFolio) — así una falla justo después de consumir
      // el folio no lo deja huérfano. El PDF se arma después, ya con el folio
      // confirmado, y su guardado sigue siendo best-effort más abajo.
      const requisicion = await createRequisicionConFolio(product.codigo, {
        productId: product.id,
        productNombre: product.nombre,
        productCodigo: product.codigo,
        etiqueta,
        descripcion,
        cantidad: cantidadNum,
        usuario: user?.username ?? null,
      });
      const pdfBytes = await buildRequisicionPdf(product, {
        folio: requisicion.folio,
        etiqueta,
        cantidad: cantidadNum,
      });
      setResultado(requisicion);
      logEvent(
        "INFO",
        `Requisición #${requisicion.numero_dia} generada: ${cantidadNum} - ${etiqueta}`,
        user?.username ?? null,
      );

      // El guardado del PDF es best-effort: el envío de WhatsApp abajo debe
      // seguir funcionando aunque el usuario cancele o falle el diálogo de
      // guardado, a diferencia de los flujos de Producción/Compra.
      try {
        const path = await save({
          title: "Guardar requisición de material",
          defaultPath: `${requisicion.folio}.pdf`,
          filters: [{ name: "PDF", extensions: ["pdf"] }],
        });
        if (path) {
          await allowFsPath(path);
          await writeFile(path, pdfBytes);
          // WhatsApp no permite adjuntar un archivo vía el enlace wa.me (solo
          // texto precargado) — revelar el PDF ya seleccionado en el
          // explorador de archivos deja el arrastrarlo al chat como único paso.
          try {
            await revealItemInDir(path);
          } catch {
            // No crítico: el PDF ya quedó guardado en `path` de todos modos.
          }
        }
      } catch (err) {
        logEvent(
          "ERROR",
          `No se pudo guardar el PDF de la requisición ${requisicion.folio}: ${String(err)}`,
          user?.username ?? null,
        );
      }

      try {
        await openUrl(buildWhatsAppUrl(requisicion.mensaje));
      } catch {
        // El usuario puede reintentar con el botón "Abrir WhatsApp" de abajo.
      }
    } catch (err) {
      setError(`No se pudo registrar la requisición: ${String(err)}`);
      logEvent(
        "ERROR",
        `Error al generar requisición para "${etiqueta}": ${String(err)}`,
        user?.username ?? null,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        <h2>Requisición a bodega</h2>
        <p>
          <strong>{etiqueta}</strong>
        </p>
        {descripcion && <p className="hint">{descripcion}</p>}

        {resultado ? (
          <>
            <p className="hint">
              Requisición generada correctamente — número {resultado.numero_dia} del día.
              <br />
              Folio: {resultado.folio}
            </p>
            <div className="form-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => openUrl(buildWhatsAppUrl(resultado.mensaje))}
              >
                Abrir WhatsApp
              </button>
              <button type="button" className="btn btn-primary" onClick={onClose}>
                Cerrar
              </button>
            </div>
          </>
        ) : (
          <>
            <label>
              Cantidad requerida
              <input
                type="text"
                inputMode="decimal"
                value={cantidad}
                onChange={(e) => setCantidad(e.target.value)}
                disabled={saving}
                autoFocus
              />
            </label>
            {error && <p className="form-error">{error}</p>}
            <div className="form-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleGenerar}
                disabled={saving}
              >
                {saving ? "Generando…" : "Generar requisición"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
