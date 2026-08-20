import { useEffect, useState } from "react";
import { getImageSrc, getPlasticPieces, pickImage, savePlasticPieces } from "../db";
import type { PlasticPiece } from "../types";
import AutoGrowInput from "./AutoGrowInput";
import Toast from "./Toast";

interface Props {
  productId: number;
  onBack: () => void;
}

export default function PlasticosSection({ productId, onBack }: Props) {
  const [pieces, setPieces] = useState<PlasticPiece[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPlasticPieces(productId).then((p) => {
      setPieces(p);
      setLoading(false);
    });
  }, [productId]);

  function updatePiece(index: number, key: "sku" | "color", value: string) {
    setDirty(true);
    setPieces((prev) => prev.map((p, i) => (i === index ? { ...p, [key]: value } : p)));
  }

  function addPiece() {
    setDirty(true);
    setPieces((prev) => [...prev, { sku: "", color: "", imagen: null, orden: prev.length + 1 }]);
  }

  function removePiece(index: number) {
    setDirty(true);
    setPieces((prev) => prev.filter((_, i) => i !== index));
  }

  async function pickImageForPiece(index: number) {
    const image = await pickImage();
    if (!image) return;
    setDirty(true);
    setPieces((prev) => prev.map((p, i) => (i === index ? { ...p, imagen: image } : p)));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await savePlasticPieces(productId, pieces);
      setDirty(false);
      setShowToast(true);
    } catch (err) {
      setError(`No se pudo guardar: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="private-section">
        <button className="btn-link" onClick={onBack}>
          ← Volver a la ficha técnica
        </button>
        <p className="hint">Cargando…</p>
      </div>
    );
  }

  return (
    <div className="private-section">
      <button className="btn-link" onClick={onBack}>
        ← Volver a la ficha técnica
      </button>
      <h1>Plásticos</h1>
      <p className="hint">SKU, color e imagen de referencia de cada pieza.</p>

      <div className="pieces-list">
        {pieces.map((piece, index) => (
          <PieceRow
            key={index}
            piece={piece}
            onSkuChange={(v) => updatePiece(index, "sku", v)}
            onColorChange={(v) => updatePiece(index, "color", v)}
            onPickImage={() => pickImageForPiece(index)}
            onRemove={() => removePiece(index)}
          />
        ))}
      </div>

      <button type="button" className="btn-link" onClick={addPiece}>
        + Agregar pieza
      </button>

      {error && <p className="form-error">{error}</p>}

      <div className="form-actions">
        <button className="btn btn-primary" onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "Guardando…" : "Guardar"}
        </button>
      </div>

      <Toast message="Guardado con éxito" show={showToast} onHide={() => setShowToast(false)} />
    </div>
  );
}

interface PieceRowProps {
  piece: PlasticPiece;
  onSkuChange: (v: string) => void;
  onColorChange: (v: string) => void;
  onPickImage: () => void;
  onRemove: () => void;
}

function PieceRow({ piece, onSkuChange, onColorChange, onPickImage, onRemove }: PieceRowProps) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getImageSrc(piece.imagen).then((src) => {
      if (!cancelled) setImageSrc(src);
    });
    return () => {
      cancelled = true;
    };
  }, [piece.imagen]);

  return (
    <div className="piece-row">
      {imageSrc ? (
        <img src={imageSrc} alt={piece.sku} className="piece-thumb" />
      ) : (
        <div className="piece-thumb piece-thumb-empty" />
      )}
      <AutoGrowInput placeholder="SKU" value={piece.sku} onChange={onSkuChange} />
      <AutoGrowInput placeholder="Color" value={piece.color} onChange={onColorChange} />
      <button type="button" className="btn btn-secondary" onClick={onPickImage}>
        {imageSrc ? "Cambiar imagen" : "Imagen"}
      </button>
      <button type="button" className="btn-link" onClick={onRemove}>
        Quitar
      </button>
    </div>
  );
}
