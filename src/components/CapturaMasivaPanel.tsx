import { useState } from "react";
import FichaImportPanel from "./FichaImportPanel";
import ImageImportPanel from "./ImageImportPanel";
import PreciosImportPanel from "./PreciosImportPanel";
import PiezasImportPanel from "./PiezasImportPanel";
import MaderaImportPanel from "./MaderaImportPanel";
import CorreccionImportPanel from "./CorreccionImportPanel";

type SubTab = "fichas" | "imagenes" | "precios" | "piezas" | "maderas" | "correccion";

const SUB_TABS: { value: SubTab; label: string }[] = [
  { value: "fichas", label: "Fichas técnicas" },
  { value: "imagenes", label: "Imágenes" },
  { value: "precios", label: "Precios Imprenta" },
  { value: "piezas", label: "Piezas" },
  { value: "maderas", label: "Maderas" },
  { value: "correccion", label: "Datos y Precios Venta" },
];

export default function CapturaMasivaPanel() {
  const [subTab, setSubTab] = useState<SubTab>("fichas");

  return (
    <div>
      <h2>Captura masiva</h2>
      <div className="search-filters" role="group" aria-label="Tipo de captura masiva">
        {SUB_TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            className={`filter-chip${subTab === t.value ? " filter-chip-active" : ""}`}
            onClick={() => setSubTab(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === "fichas" && <FichaImportPanel />}
      {subTab === "imagenes" && <ImageImportPanel />}
      {subTab === "precios" && <PreciosImportPanel />}
      {subTab === "piezas" && <PiezasImportPanel />}
      {subTab === "maderas" && <MaderaImportPanel />}
      {subTab === "correccion" && <CorreccionImportPanel />}
    </div>
  );
}
