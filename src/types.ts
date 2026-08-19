export interface Product {
  id: number;
  codigo: string;
  nombre: string;
  categoria: string;
  material: string;
  descripcion: string;
  imagen: string | null;
  creado_en: string;
}

export interface ProductSpec {
  id?: number;
  product_id?: number;
  etiqueta: string;
  valor: string;
  orden: number;
}

export interface ProductInput {
  codigo: string;
  nombre: string;
  categoria: string;
  material: string;
  descripcion: string;
  imagen: string | null;
}
