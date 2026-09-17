// Subconjunto de columnas de las tablas de la base Turso de licenciamiento
// (ver scripts/create-installations-db-schema.mjs) relevante para este
// Worker. No se importa desde src/types.ts (app principal) a propósito:
// son dos proyectos TypeScript separados con distinto target de build, y
// el número de campos compartidos es chico — copiar es más simple que
// acoplar los dos builds.

export type InstalacionEstado = "activa" | "revocada";

export interface CredentialRow {
  id: number;
  code_hash: string;
  code_preview: string;
  sede_codigo: string;
  sede_nombre: string;
  descripcion: string;
  usuario_responsable: string | null;
  estado: InstalacionEstado;
  installation_id: number | null;
  creado_por: string;
  creado_en: string;
  usado_en: string | null;
}

export interface InstallationRow {
  id: number;
  installation_code: string;
  seq: number;
  sede_codigo: string;
  sede_nombre: string;
  descripcion: string;
  device_token_hash: string;
  estado: InstalacionEstado;
  ultima_version: string | null;
  ultima_conexion_en: string | null;
  activada_en: string;
  revocada_en: string | null;
  reactivada_en: string | null;
}
