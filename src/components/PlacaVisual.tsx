import type { SheetLayoutResult, PlacedPieceMm } from "../corteMaderaLayout";
import { SHEET_HEIGHT_MM, SHEET_WIDTH_MM } from "../corteMaderaLayout";

export type PlacaOrientacion = "vertical" | "horizontal";

interface Props {
  layout: Extract<SheetLayoutResult, { ok: true }>;
  orientation: PlacaOrientacion;
}

// Umbral de sanidad para no superponer texto ilegible sobre piezas chicas —
// el conteo total ya vive en el panel de "Resultado del corte", el texto
// dentro de cada rect es solo una ayuda visual cuando hay espacio.
const MIN_LABEL_WIDTH_MM = 150;
const MIN_LABEL_HEIGHT_MM = 80;

// Aire entre el marco del recuadro y la placa — puramente visual, un
// viewBox más grande que el contenido real. padYMm se deriva de padXMm
// manteniendo la proporción exacta del recuadro (outerWidth:outerHeight),
// así el margen se ve igual de ancho en los 4 lados sin importar la
// orientación (si no, un padding "parejo" en mm se vería más angosto en el
// eje que la pantalla escala más).
const PAD_RATIO = 0.025;

function piezaLabel(widthMm: number, heightMm: number): string {
  return `${Math.round(widthMm / 10)} × ${Math.round(heightMm / 10)} cm`;
}

export default function PlacaVisual({ layout, orientation }: Props) {
  const isHorizontal = orientation === "horizontal";
  // "Horizontal" no es una rotación física real de la placa (eso cambiaría
  // qué corte queda en qué eje) — es solo una transposición de la misma
  // distribución para verla acostada, conveniencia de visualización.
  const outerWidthMm = isHorizontal ? SHEET_HEIGHT_MM : SHEET_WIDTH_MM;
  const outerHeightMm = isHorizontal ? SHEET_WIDTH_MM : SHEET_HEIGHT_MM;
  const padXMm = outerWidthMm * PAD_RATIO;
  const padYMm = padXMm * (outerHeightMm / outerWidthMm);

  function mapPiece(p: PlacedPieceMm) {
    return isHorizontal
      ? { xMm: p.yMm, yMm: p.xMm, widthMm: p.heightMm, heightMm: p.widthMm }
      : { xMm: p.xMm, yMm: p.yMm, widthMm: p.widthMm, heightMm: p.heightMm };
  }

  return (
    <div className="corte-madera-placa-wrap">
      <svg
        viewBox={`${-padXMm} ${-padYMm} ${outerWidthMm + 2 * padXMm} ${outerHeightMm + 2 * padYMm}`}
        role="img"
        aria-label={`Placa de MDF de 122 por 244 centímetros con ${layout.count} piezas acomodadas`}
        className={`corte-madera-placa-svg corte-madera-placa-svg-${orientation}`}
      >
        <rect
          x={0}
          y={0}
          width={outerWidthMm}
          height={outerHeightMm}
          className="corte-madera-placa-fondo"
        />
        {layout.placed.map((raw, i) => {
          const p = mapPiece(raw);
          return (
            <g key={i}>
              <rect
                x={p.xMm}
                y={p.yMm}
                width={p.widthMm}
                height={p.heightMm}
                rx={6}
                className="corte-madera-pieza"
              />
              {p.widthMm >= MIN_LABEL_WIDTH_MM && p.heightMm >= MIN_LABEL_HEIGHT_MM && (
                <text
                  x={p.xMm + p.widthMm / 2}
                  y={p.yMm + p.heightMm / 2}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="corte-madera-pieza-label"
                >
                  {piezaLabel(raw.widthMm, raw.heightMm)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
