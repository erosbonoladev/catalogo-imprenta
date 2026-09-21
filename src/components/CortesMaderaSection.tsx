import { useEffect, useState } from "react";
import { hasPermission, useAuth } from "../auth";
import { createWoodProduct, logEventAsActor } from "../db";
import { parseAmount } from "../precios";
import type { WoodProduct } from "../types";
import {
  CUTTER_GAP_MM,
  GRAMAJES_MADERA,
  computeSheetLayout,
  parseDimensionCm,
  parsePiezaMedidaFromTexto,
  type GramajeMadera,
  type PieceSizeMm,
} from "../corteMaderaLayout";
import WoodProductPicker from "./WoodProductPicker";
import { EMPTY_WOOD_DATA } from "./WoodProductFields";
import PlacaVisual, { type PlacaOrientacion } from "./PlacaVisual";
import Toast from "./Toast";

type Origen = "catalogo" | "manual";
type Modo = "pieza" | "armado";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="plastic-item-view-field">
      <span className="plastic-item-view-field-label">{label}</span>
      <span className="plastic-item-view-field-value">{value}</span>
    </div>
  );
}

function orientationLabel(o: "normal" | "rotada" | "combinada"): string {
  if (o === "normal") return "Normal";
  if (o === "rotada") return "Rotada 90°";
  return "Combinada (normal + rotada)";
}

export default function CortesMaderaSection() {
  const { user, token } = useAuth();
  const allowed = hasPermission(user, "maderas");

  const [origen, setOrigen] = useState<Origen>("catalogo");
  const [showPicker, setShowPicker] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<WoodProduct | null>(null);
  const [modo, setModo] = useState<Modo>("armado");

  const [manualAnchoRaw, setManualAnchoRaw] = useState("");
  const [manualLargoRaw, setManualLargoRaw] = useState("");

  const [showSaveManual, setShowSaveManual] = useState(false);
  const [manualSaveNombre, setManualSaveNombre] = useState("");
  const [manualSaveSku, setManualSaveSku] = useState("");
  const [savingManual, setSavingManual] = useState(false);
  const [manualSaveError, setManualSaveError] = useState<string | null>(null);
  const [showManualSaveToast, setShowManualSaveToast] = useState(false);

  const [gramaje, setGramaje] = useState<GramajeMadera>(GRAMAJES_MADERA[0]);
  const [margenRaw, setMargenRaw] = useState("0");
  const [incluirMargenCortadora, setIncluirMargenCortadora] = useState(true);
  const [placaOrientacion, setPlacaOrientacion] = useState<PlacaOrientacion>("vertical");

  useEffect(() => {
    if (allowed || !user || !token) return;
    logEventAsActor(
      { id: user.id, token },
      "WARNING",
      `Acceso denegado a Cortes de Madera para ${user.username}`,
    );
  }, [allowed, user, token]);

  if (!allowed) {
    return (
      <div className="private-section">
        <h1>Acceso denegado</h1>
        <p className="hint">No tienes permiso para ver esta sección.</p>
      </div>
    );
  }

  async function handleSaveManualPiece() {
    if (!user || !token) return;
    const nombre = manualSaveNombre.trim();
    if (!nombre) {
      setManualSaveError("Ingresa un nombre para guardar la pieza.");
      return;
    }
    const actor = { id: user.id, token };
    setSavingManual(true);
    setManualSaveError(null);
    try {
      await createWoodProduct(actor, {
        ...EMPTY_WOOD_DATA,
        nombre,
        sku: manualSaveSku.trim(),
        ancho: manualAnchoRaw.trim(),
        largo: manualLargoRaw.trim(),
      });
      setShowSaveManual(false);
      setManualSaveNombre("");
      setManualSaveSku("");
      setShowManualSaveToast(true);
    } catch (err) {
      setManualSaveError(`No se pudo guardar: ${String(err)}`);
      logEventAsActor(actor, "ERROR", `No se pudo guardar pieza manual de Cortes de Madera: ${String(err)}`);
    } finally {
      setSavingManual(false);
    }
  }

  function handleSelectProduct(producto: WoodProduct) {
    setSelectedProduct(producto);
    setShowPicker(false);
    const tieneArmado =
      parseDimensionCm(producto.ancho) !== null && parseDimensionCm(producto.largo) !== null;
    setModo(tieneArmado ? "armado" : "pieza");
  }

  const piezaMedida = selectedProduct ? parsePiezaMedidaFromTexto(selectedProduct.tamano) : null;
  const armadoAnchoMm = selectedProduct ? parseDimensionCm(selectedProduct.ancho) : null;
  const armadoLargoMm = selectedProduct ? parseDimensionCm(selectedProduct.largo) : null;
  const piezaDisponible = piezaMedida !== null;
  const armadoDisponible = armadoAnchoMm !== null && armadoLargoMm !== null;

  const manualAnchoMm = parseDimensionCm(manualAnchoRaw);
  const manualLargoMm = parseDimensionCm(manualLargoRaw);
  const manualValido = manualAnchoMm !== null && manualLargoMm !== null;
  const manualTieneTexto = manualAnchoRaw.trim() !== "" || manualLargoRaw.trim() !== "";

  let pieceSize: PieceSizeMm | null = null;
  if (origen === "manual") {
    pieceSize = manualValido ? { widthMm: manualAnchoMm as number, heightMm: manualLargoMm as number } : null;
  } else if (selectedProduct) {
    if (modo === "armado" && armadoDisponible) {
      pieceSize = { widthMm: armadoAnchoMm as number, heightMm: armadoLargoMm as number };
    } else if (modo === "pieza" && piezaDisponible) {
      pieceSize = piezaMedida;
    }
  }

  const margenMm = parseAmount(margenRaw);
  const margenTieneTexto = margenRaw.trim() !== "";

  const layout =
    pieceSize && margenMm !== null
      ? computeSheetLayout(pieceSize, margenMm, incluirMargenCortadora)
      : null;
  const modoLabel = origen === "manual" ? "Manual" : modo === "pieza" ? "Pieza" : "Armado";

  return (
    <div className="private-section">
      <h1>Cortes de Madera</h1>
      <p className="hint">Placa MDF: 122 × 244 cm</p>

      <h2>Tamaño de corte</h2>
      <div className="search-filters" role="group" aria-label="Origen de la pieza">
        <button
          type="button"
          className={`filter-chip${origen === "catalogo" ? " filter-chip-active" : ""}`}
          onClick={() => setOrigen("catalogo")}
        >
          Buscar en el catálogo
        </button>
        <button
          type="button"
          className={`filter-chip${origen === "manual" ? " filter-chip-active" : ""}`}
          onClick={() => setOrigen("manual")}
        >
          Agregar pieza manualmente
        </button>
      </div>

      {origen === "catalogo" && (
        <div style={{ marginTop: "1rem" }}>
          {!selectedProduct ? (
            <button type="button" className="btn btn-secondary" onClick={() => setShowPicker(true)}>
              Buscar pieza de madera
            </button>
          ) : (
            <>
              <div className="plastic-item-view-fields">
                <Field label="Nombre" value={selectedProduct.nombre || "—"} />
                <Field label="SKU" value={selectedProduct.sku || "—"} />
                <Field label="Pieza" value={selectedProduct.tamano || "—"} />
                <Field
                  label="Armado"
                  value={
                    selectedProduct.ancho || selectedProduct.largo
                      ? `${selectedProduct.ancho || "—"} × ${selectedProduct.largo || "—"}`
                      : "—"
                  }
                />
              </div>
              <div className="form-actions" style={{ margin: "0.75rem 0" }}>
                <button type="button" className="btn-link" onClick={() => setShowPicker(true)}>
                  Cambiar pieza
                </button>
              </div>

              <div className="search-filters" role="group" aria-label="Modo de cálculo">
                <button
                  type="button"
                  className={`filter-chip${modo === "pieza" ? " filter-chip-active" : ""}`}
                  onClick={() => setModo("pieza")}
                  disabled={!piezaDisponible}
                  title={
                    piezaDisponible
                      ? undefined
                      : "Esta pieza no tiene una medida reconocible en el campo Pieza."
                  }
                >
                  Pieza
                </button>
                <button
                  type="button"
                  className={`filter-chip${modo === "armado" ? " filter-chip-active" : ""}`}
                  onClick={() => setModo("armado")}
                  disabled={!armadoDisponible}
                  title={
                    armadoDisponible
                      ? undefined
                      : "Esta pieza no tiene Largo/Ancho numéricos válidos en Armado."
                  }
                >
                  Armado
                </button>
              </div>
              {!piezaDisponible && (
                <p className="hint">
                  Modo Pieza no disponible: el campo Pieza ("{selectedProduct.tamano || "—"}") no
                  tiene una medida reconocible (ej. "67x28"). Usa Armado.
                </p>
              )}
              {!armadoDisponible && (
                <p className="hint">
                  Modo Armado no disponible: esta pieza no tiene Largo/Ancho numéricos válidos.
                </p>
              )}
            </>
          )}

          {showPicker && (
            <WoodProductPicker
              excludeIds={[]}
              onSelect={handleSelectProduct}
              onClose={() => setShowPicker(false)}
            />
          )}
        </div>
      )}

      {origen === "manual" && (
        <div style={{ marginTop: "1rem" }}>
          <div className="plastic-item-fields">
            <label className="plastic-item-field">
              <span>Ancho (cm)</span>
              <input
                type="text"
                inputMode="decimal"
                value={manualAnchoRaw}
                onChange={(e) => setManualAnchoRaw(e.target.value)}
              />
            </label>
            <label className="plastic-item-field">
              <span>Largo (cm)</span>
              <input
                type="text"
                inputMode="decimal"
                value={manualLargoRaw}
                onChange={(e) => setManualLargoRaw(e.target.value)}
              />
            </label>
          </div>
          {manualTieneTexto && !manualValido && (
            <p className="form-error">Ancho y Largo deben ser números mayores a 0.</p>
          )}

          {manualValido && (
            <div style={{ marginTop: "0.75rem" }}>
              {!showSaveManual ? (
                <button type="button" className="btn-link" onClick={() => setShowSaveManual(true)}>
                  Guardar esta pieza en el catálogo de Maderas
                </button>
              ) : (
                <div className="plastic-item-fields">
                  <label className="plastic-item-field">
                    <span>Nombre</span>
                    <input
                      type="text"
                      value={manualSaveNombre}
                      onChange={(e) => setManualSaveNombre(e.target.value)}
                      autoFocus
                    />
                  </label>
                  <label className="plastic-item-field">
                    <span>SKU (opcional)</span>
                    <input
                      type="text"
                      value={manualSaveSku}
                      onChange={(e) => setManualSaveSku(e.target.value)}
                    />
                  </label>
                  {manualSaveError && <p className="form-error">{manualSaveError}</p>}
                  <div className="form-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={handleSaveManualPiece}
                      disabled={savingManual}
                    >
                      {savingManual ? "Guardando…" : "Guardar en el catálogo"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        setShowSaveManual(false);
                        setManualSaveError(null);
                      }}
                      disabled={savingManual}
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="form-row" style={{ marginTop: "1.25rem" }}>
        <label>
          Gramaje
          <select
            value={gramaje}
            onChange={(e) => setGramaje(Number(e.target.value) as GramajeMadera)}
          >
            {GRAMAJES_MADERA.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </label>
        <label>
          Margen adicional (mm)
          <input
            type="text"
            inputMode="decimal"
            value={margenRaw}
            onChange={(e) => setMargenRaw(e.target.value)}
          />
        </label>
      </div>
      <label className="checkbox-label" style={{ marginTop: "0.6rem" }}>
        <input
          type="checkbox"
          checked={incluirMargenCortadora}
          onChange={(e) => setIncluirMargenCortadora(e.target.checked)}
        />
        Incluir el margen de {CUTTER_GAP_MM}mm de la cortadora
      </label>
      {margenTieneTexto && margenMm === null && (
        <p className="form-error">El margen debe ser un número mayor o igual a 0.</p>
      )}

      <h2 style={{ marginTop: "1.5rem" }}>Resultado del corte</h2>
      {!pieceSize && (
        <p className="hint">Selecciona una pieza y un modo de cálculo para ver el resultado.</p>
      )}
      {pieceSize && margenMm === null && (
        <p className="hint">Ingresa un margen válido para calcular.</p>
      )}
      {layout && !layout.ok && <p className="form-error">{layout.reason}</p>}
      {layout && layout.ok && (
        <>
          <div className="plastic-item-view-fields">
            <Field label="Placa" value="122 × 244 cm" />
            <Field
              label="Pieza utilizada"
              value={`${(layout.piece.widthMm / 10).toFixed(1)} × ${(layout.piece.heightMm / 10).toFixed(1)} cm`}
            />
            <Field label="Modo" value={modoLabel} />
            <Field label="Gramaje" value={String(gramaje)} />
            <Field label="Margen adicional" value={`${margenMm} mm`} />
            <Field label="Separación real" value={`${layout.gapMm} mm`} />
            <Field label="Piezas obtenidas" value={String(layout.count)} />
            <Field label="Área utilizada" value={`${layout.usedAreaPct}%`} />
            <Field label="Desperdicio" value={`${layout.wastePct}%`} />
            <Field label="Área restante" value={`${(layout.wasteAreaMm2 / 100).toFixed(1)} cm²`} />
            <Field label="Orientación utilizada" value={orientationLabel(layout.orientation)} />
          </div>
          <div className="search-filters" role="group" aria-label="Orientación de la placa">
            <button
              type="button"
              className={`filter-chip${placaOrientacion === "vertical" ? " filter-chip-active" : ""}`}
              onClick={() => setPlacaOrientacion("vertical")}
            >
              Vertical
            </button>
            <button
              type="button"
              className={`filter-chip${placaOrientacion === "horizontal" ? " filter-chip-active" : ""}`}
              onClick={() => setPlacaOrientacion("horizontal")}
            >
              Horizontal
            </button>
          </div>
          <PlacaVisual layout={layout} orientation={placaOrientacion} />
        </>
      )}

      <Toast
        message="Pieza guardada en el catálogo de Maderas"
        show={showManualSaveToast}
        onHide={() => setShowManualSaveToast(false)}
      />
    </div>
  );
}
