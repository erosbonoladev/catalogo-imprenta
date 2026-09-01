import { useState } from "react";
import FichaImportPanel from "./FichaImportPanel";
import ImageImportPanel from "./ImageImportPanel";
import PreciosImportPanel from "./PreciosImportPanel";

type SubTab = "fichas" | "imagenes" | "precios";

const SUB_TABS: { value: SubTab; label: string }[] = [
  { value: "fichas", label: "Fichas técnicas" },
  { value: "imagenes", label: "Imágenes" },
  { value: "precios", label: "Precios" },
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
    </div>
  );
}
