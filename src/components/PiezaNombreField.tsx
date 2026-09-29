import { useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { getPlasticProduct, listPlasticProductsSummary } from "../db";
import type { PlasticProduct, PlasticProductInput } from "../types";
import AutoGrowInput from "./AutoGrowInput";

// Copia el resto de la ficha de una coincidencia como plantilla para una
// pieza NUEVA (ej. "Casco de Policía" → estás creando "Casco de Bombero":
// mismo material/dimensión/precio, solo cambia el color) — nombre y SKU
// quedan fuera a propósito, son lo que distingue a la pieza nueva de la
// que se usó como plantilla (pedido explícito del usuario).
export function pickTemplateFields(p: PlasticProduct): Omit<PlasticProductInput, "nombre" | "sku"> {
  return {
    color: p.color,
    origen: p.origen,
    descripcion: p.descripcion,
    material: p.material,
    dimension: p.dimension,
    peso: p.peso,
    maquila: p.maquila,
    coste: p.coste,
    componentes_fabricacion: p.componentes_fabricacion,
    precio_por_pieza: p.precio_por_pieza,
    precio_por_juego: p.precio_por_juego,
    imagen: p.imagen,
  };
}

// Mismo criterio de plegado que normalizeSearchTerm en db.ts: NFD + quitar
// diacríticos + minúsculas, para que "Tornillo" encuentre "tornillo"/"TORNILLO".
function normalizeNombre(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

const MIN_QUERY_LENGTH = 2;
// Nombres de una sola letra ("a", "b", "c"…) son basura de captura, no
// piezas reales — filtrarlos por longitud evita que calcen por sustring
// contra casi cualquier nombre que se esté escribiendo.
const MIN_CANDIDATE_LENGTH = 2;
const MAX_SUGGESTIONS = 20;

interface Props {
  value: string;
  onChange: (value: string) => void;
  // Pieza que este campo ya representa (edición o vínculo existente) — se
  // excluye de sus propias coincidencias.
  excludeId?: number | null;
  placeholder?: string;
  className?: string;
  // Si se pasa: seleccionar una coincidencia NO toca este campo (nombre
  // propio de la pieza nueva) — en cambio se pide la pieza completa
  // (con imagen, que listPlasticProductsSummary no trae) y se entrega acá
  // para que el caller copie el resto de la ficha con pickTemplateFields.
  // Si se omite (edición de una pieza existente): seleccionar una
  // coincidencia solo alinea el nombre escrito con el de la coincidencia,
  // sin tocar el resto de una ficha que ya es real en la BD.
  onSelectMatch?: (product: PlasticProduct) => void;
}

// Input de "Nombre" para Piezas con un dropdown de coincidencias navegable
// (flechas/Enter/click, como un autocompletar de buscador) contra el
// catálogo maestro de plastic_products — usado en PiezaFormModal
// (PiezasGeneralSection) y en PlasticItemCard (PlasticosSection) para que el
// usuario note si ya existe una pieza parecida antes de crear otra.
export default function PiezaNombreField({
  value,
  onChange,
  excludeId,
  placeholder,
  className,
  onSelectMatch,
}: Props) {
  const [catalogPiezas, setCatalogPiezas] = useState<PlasticProduct[]>([]);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);

  useEffect(() => {
    listPlasticProductsSummary()
      .then(setCatalogPiezas)
      .catch(() => {});
  }, []);

  const matches = useMemo(() => {
    const query = normalizeNombre(value);
    if (query.length < MIN_QUERY_LENGTH) return [];
    return catalogPiezas.filter((p) => {
      if (excludeId && p.id === excludeId) return false;
      const candidate = normalizeNombre(p.nombre);
      return candidate.length >= MIN_CANDIDATE_LENGTH && candidate.includes(query);
    });
  }, [catalogPiezas, value, excludeId]);

  const visibleMatches = matches.slice(0, MAX_SUGGESTIONS);
  const showDropdown = open && visibleMatches.length > 0;

  useEffect(() => {
    setHighlighted(0);
  }, [value]);

  function selectMatch(p: PlasticProduct) {
    setOpen(false);
    if (onSelectMatch) {
      getPlasticProduct(p.id)
        .then((full) => {
          if (full) onSelectMatch(full);
        })
        .catch(() => {});
    } else {
      onChange(p.nombre);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!showDropdown) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => (h + 1) % visibleMatches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => (h - 1 + visibleMatches.length) % visibleMatches.length);
    } else if (e.key === "Enter") {
      const target = visibleMatches[highlighted];
      if (target) {
        e.preventDefault();
        selectMatch(target);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="pieza-nombre-field-wrap">
      <AutoGrowInput
        className={className}
        placeholder={placeholder}
        value={value}
        onChange={(v) => {
          onChange(v);
          setOpen(true);
        }}
        onKeyDown={handleKeyDown}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
      />
      {showDropdown && (
        <ul className="pieza-nombre-suggestions" role="listbox">
          <li className="pieza-nombre-suggestions-hint" aria-hidden="true">
            {onSelectMatch
              ? "Clic para copiar el resto de los datos de esa pieza (nombre y SKU propios se conservan)"
              : "Clic para usar ese nombre"}
          </li>
          {visibleMatches.map((p, i) => (
            <li
              key={p.id}
              role="option"
              aria-selected={i === highlighted}
              className={`pieza-nombre-suggestion${i === highlighted ? " is-active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                selectMatch(p);
              }}
              onMouseEnter={() => setHighlighted(i)}
            >
              <span className="pieza-nombre-suggestion-nombre">{p.nombre}</span>
              {p.sku && <span className="pieza-nombre-suggestion-sku">SKU {p.sku}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
