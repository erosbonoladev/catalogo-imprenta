# Genera Assets/remision-template-externa.png a partir de Assets/remision-template.png
# (plantilla de remisión interna) para las remisiones EXTERNAS:
#  - quita la columna "Clave" (la información de clave es interna) recorriendo el resto
#    de la tabla hacia la izquierda; "Producto" queda como columna ancha después de "Cantidad";
#  - borra el bloque fijo "Cliente: Bodegas Educativas…" (ahí va el bloque capturable
#    Cliente/RFC/Dirección/Contacto/Tel, que dibujan la hoja y el PDF);
#  - borra el bloque "PEDIDO BODEGAS" (el cliente ya se captura a la izquierda).
# Las coordenadas están en píxeles del raster original (1696×2400, 1 px = 595.5/1696 pt).
# Requiere Pillow:  python3 -m venv v && v/bin/pip install pillow && v/bin/python scripts/generate-remision-template-externa.py
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
src = Image.open(root / "Assets" / "remision-template.png").convert("RGB")
out = src.copy()
K = 1696 / 595.5

L0, L1 = 66, 182          # borde izquierdo de la tabla y línea Clave|Cantidad
SHIFT = L1 - L0           # ancho de la columna Clave
PRECIO_LINE = 1176        # línea Producto|Precio (no se mueve)
Y0, Y1 = 648, 1976        # alto de la tabla (encabezado + 16 renglones)
BLANK_X = 600             # franja vacía de la columna Producto, para rellenar el hueco

x0 = L0 + 3
x_src_end = PRECIO_LINE - 4
w = x_src_end - (x0 + SHIFT)
out.paste(src.crop((x0 + SHIFT, Y0, x_src_end, Y1)), (x0, Y0))
gap = x_src_end - SHIFT + 0  # x donde termina el contenido recorrido (en la imagen nueva)
gap_start = x_src_end - SHIFT
gap_w = x_src_end - gap_start
out.paste(src.crop((BLANK_X, Y0, BLANK_X + SHIFT, Y1)), (gap_start, Y0))


def erase(x, y, w_, h):
    out.paste((255, 255, 255), (round(x * K), round(y * K), round((x + w_) * K), round((y + h) * K)))


erase(22, 139, 195, 37)    # bloque Cliente/Guadalajara/RFC
erase(455, 187, 135, 36)   # bloque PEDIDO BODEGAS (línea, etiqueta y valor)
out.save(root / "Assets" / "remision-template-externa.png", optimize=True)
print("ok", out.size)
