import { useState } from "react";
import FichaImportPanel from "./FichaImportPanel";
import ImageImportPanel from "./ImageImportPanel";
import BarcodeImageImportPanel from "./BarcodeImageImportPanel";
import PreciosImportPanel from "./PreciosImportPanel";
import PiezasImportPanel from "./PiezasImportPanel";
import MaderaImportPanel from "./MaderaImportPanel";
import CorreccionImportPanel from "./CorreccionImportPanel";

type SubTab = "fichas" | "imagenes" | "codigo_barras" | "precios" | "piezas" | "maderas" | "correccion";

const SUB_TABS: { value: SubTab; label: string }[] = [
  { value: "fichas", label: "Fichas técnicas" },
  { value: "imagenes", label: "Imágenes" },
  { value: "codigo_barras", label: "Código de barras" },
  { value: "precios", label: "Precios Imprenta" },
  { value: "piezas", label: "Piezas" },
  { value: "maderas", label: "Maderas" },
  { value: "correccion", label: "Datos y Precios Venta" },
];

interface Props {
  onDirtyChange?: (dirty: boolean) => void;
}

export default function CapturaMasivaPanel({ onDirtyChange }: Props) {
  const [subTab, setSubTab] = useState<SubTab>("fichas");
  // Solo Correccion reporta dirty por ahora (fue la que mostró el riesgo real
  // de commit en segundo plano) — mientras está en true, bloqueamos cambiar
  // de sub-pestaña acá mismo, además de reenviarlo hacia arriba para que
  // Configuraciones/App bloqueen salir de toda la sección.
  const [importBusy, setImportBusy] = useState(false);

  function handleImportBusyChange(busy: boolean) {
    setImportBusy(busy);
    onDirtyChange?.(busy);
  }

  return (
    <div>
      <h2>Captura masiva</h2>
      <div className="search-filters" role="group" aria-label="Tipo de captura masiva">
        {SUB_TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            className={`filter-chip${subTab === t.value ? " filter-chip-active" : ""}`}
            disabled={importBusy && subTab !== t.value}
            onClick={() => setSubTab(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {importBusy && (
        <p className="hint" style={{ marginTop: "0.4rem" }}>
          Hay una importación en curso — no se puede cambiar de pestaña hasta que termine.
        </p>
      )}

      {subTab === "fichas" && <FichaImportPanel />}
      {subTab === "imagenes" && <ImageImportPanel />}
      {subTab === "codigo_barras" && <BarcodeImageImportPanel />}
      {subTab === "precios" && <PreciosImportPanel />}
      {subTab === "piezas" && <PiezasImportPanel />}
      {subTab === "maderas" && <MaderaImportPanel />}
      {subTab === "correccion" && <CorreccionImportPanel onDirtyChange={handleImportBusyChange} />}
    </div>
  );
}
