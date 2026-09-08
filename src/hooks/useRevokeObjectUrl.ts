import { useEffect } from "react";

/**
 * getImageSrc() (db.ts) crea un URL.createObjectURL() por cada llamada, y
 * nada en el repo lo revocaba — cada vez que un componente reemplazaba su
 * imagen (nuevo producto seleccionado, imagen cambiada) o se desmontaba, el
 * blob URL anterior quedaba retenido en memoria por el resto de la sesión.
 * Este hook revoca `url` cuando cambia a un valor distinto y cuando el
 * componente se desmonta — un solo `useEffect(() => setImageSrc(...))` en el
 * componente sigue siendo el dueño del fetch/estado, esto solo se encarga del
 * revoke.
 */
export function useRevokeObjectUrl(url: string | null): void {
  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);
}
