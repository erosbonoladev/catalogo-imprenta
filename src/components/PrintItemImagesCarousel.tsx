import { useEffect, useState } from "react";
import { getImageSrc, pickImage } from "../db";
import type { ImageBlob, PrintItemImage } from "../types";
import basuraIcon from "../../Assets/basura.svg";

interface Props {
  images: PrintItemImage[];
  editable: boolean;
  maxImages: number;
  onAdd: (image: ImageBlob) => void;
  onReplace: (index: number, image: ImageBlob) => void;
  onRemove: (index: number) => void;
}

export default function PrintItemImagesCarousel({
  images,
  editable,
  maxImages,
  onAdd,
  onReplace,
  onRemove,
}: Props) {
  const [index, setIndex] = useState(0);
  const [src, setSrc] = useState<string | null>(null);
  const hasImages = images.length > 0;

  useEffect(() => {
    if (index > images.length - 1) {
      setIndex(Math.max(0, images.length - 1));
    }
  }, [images.length, index]);

  useEffect(() => {
    let cancelled = false;
    getImageSrc(images[index]?.imagen ?? null).then((url) => {
      if (!cancelled) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [images, index]);

  async function handleAdd() {
    const image = await pickImage();
    if (!image) return;
    onAdd(image);
  }

  async function handleReplace() {
    const image = await pickImage();
    if (!image) return;
    onReplace(index, image);
  }

  return (
    <div className="print-item-images">
      <span className="print-item-checks-label">Imágenes de armado</span>

      <div className="print-item-images-viewer">
        <button
          type="button"
          className="btn btn-secondary print-item-images-nav"
          onClick={() => setIndex((i) => i - 1)}
          disabled={!hasImages || index <= 0}
        >
          &lt;
        </button>

        <div className="print-item-images-frame">
          {src ? (
            <img src={src} alt={`Imagen de armado ${index + 1}`} />
          ) : (
            <span className="product-card-placeholder">Sin imágenes</span>
          )}
        </div>

        <button
          type="button"
          className="btn btn-secondary print-item-images-nav"
          onClick={() => setIndex((i) => i + 1)}
          disabled={!hasImages || index >= images.length - 1}
        >
          &gt;
        </button>
      </div>

      {hasImages && (
        <span className="print-item-images-counter">
          Imagen {index + 1} de {images.length}
        </span>
      )}

      {editable && (
        <>
          <div className="print-item-images-actions">
            <button
              type="button"
              className="btn-link"
              onClick={handleAdd}
              disabled={images.length >= maxImages}
            >
              + Agregar imagen
            </button>
            {hasImages && (
              <>
                <button type="button" className="btn-link" onClick={handleReplace}>
                  Reemplazar
                </button>
                <button
                  type="button"
                  className="icon-btn icon-btn-remove"
                  onClick={() => onRemove(index)}
                  title="Eliminar imagen"
                  aria-label="Eliminar imagen"
                >
                  <img src={basuraIcon} alt="" aria-hidden="true" />
                </button>
              </>
            )}
          </div>
          <p className="hint">
            {maxImages > 0
              ? `Hasta ${maxImages} imagen${maxImages === 1 ? "" : "es"} (según número de pliegos).`
              : "Captura el número de pliegos para habilitar imágenes de armado."}
          </p>
        </>
      )}
    </div>
  );
}
