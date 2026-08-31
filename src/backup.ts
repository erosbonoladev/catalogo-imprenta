import type { BackupManifest } from "./types";

/**
 * Lógica pura de armado/lectura de dumps de backup — sin acceso a la BD, para
 * poder reusarse tal cual desde el script Node del workflow de GitHub
 * Actions (repo separado) sin arrastrar @libsql/client/web ni el resto de la
 * app. Toda la parte que sí toca la BD vive en db.ts, como el resto del
 * proyecto.
 */

export interface DumpTable {
  name: string;
  createSql: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

const META_PREFIX = "-- CLIO_BACKUP_META ";

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function escapeSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value instanceof ArrayBuffer) {
    return `X'${bytesToHex(new Uint8Array(value))}'`;
  }
  if (value instanceof Uint8Array) {
    return `X'${bytesToHex(value)}'`;
  }
  return escapeSqlString(String(value));
}

function buildInsertStatement(table: DumpTable, row: Record<string, unknown>): string {
  const values = table.columns.map((c) => sqlLiteral(row[c])).join(", ");
  return `INSERT INTO ${table.name} (${table.columns.join(", ")}) VALUES (${values});`;
}

export function buildBackupSql(tables: DumpTable[]): { sql: string; manifest: BackupManifest } {
  const manifest: BackupManifest = {
    version: 1,
    creadoEn: new Date().toISOString(),
    tablas: Object.fromEntries(tables.map((t) => [t.name, t.rows.length])),
  };

  const lines: string[] = [
    "PRAGMA foreign_keys=OFF;",
    "BEGIN TRANSACTION;",
  ];
  for (const table of tables) {
    lines.push(`DROP TABLE IF EXISTS ${table.name};`);
    lines.push(`${table.createSql};`);
    for (const row of table.rows) {
      lines.push(buildInsertStatement(table, row));
    }
  }
  lines.push("COMMIT;");

  const sql = `${META_PREFIX}${JSON.stringify(manifest)}\n${lines.join("\n")}\n`;
  return { sql, manifest };
}

export function parseBackupMeta(sql: string): BackupManifest | null {
  const firstLine = sql.split("\n", 1)[0] ?? "";
  if (!firstLine.startsWith(META_PREFIX)) return null;
  try {
    return JSON.parse(firstLine.slice(META_PREFIX.length)) as BackupManifest;
  } catch {
    return null;
  }
}

/**
 * Separa un dump en statements individuales, respetando strings/blobs entre
 * comillas simples (con '' como comilla escapada) y comentarios -- de línea,
 * para que un ; dentro de un texto de producto nunca se confunda con el fin
 * de un statement.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inString = false;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];

    if (inString) {
      current += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          current += "'";
          i += 2;
          continue;
        }
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === "'") {
      inString = true;
      current += ch;
      i++;
      continue;
    }

    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      const end = nl === -1 ? sql.length : nl;
      current += sql.slice(i, end);
      i = end;
      continue;
    }

    if (ch === ";") {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

/** Statements ejecutables de un dump — sin las líneas de control (PRAGMA/BEGIN/COMMIT/comentarios), que el restore maneja aparte vía client.batch(). */
export function extractRestoreStatements(sql: string): string[] {
  return splitSqlStatements(sql).filter((s) => {
    const upper = s.trimStart().toUpperCase();
    if (upper.startsWith("--")) return false;
    if (upper.startsWith("PRAGMA")) return false;
    if (upper.startsWith("BEGIN")) return false;
    if (upper.startsWith("COMMIT")) return false;
    return true;
  });
}

export interface BackupValidation {
  ok: boolean;
  manifest: BackupManifest | null;
  errors: string[];
  statementCount: number;
}

export function validateBackupSql(sql: string): BackupValidation {
  const errors: string[] = [];
  const manifest = parseBackupMeta(sql);
  if (!manifest) {
    errors.push("No se encontró el encabezado de metadatos de Clio — no parece ser un backup válido.");
  }
  if (!sql.includes("BEGIN TRANSACTION")) {
    errors.push("Falta BEGIN TRANSACTION — el archivo parece incompleto o corrupto.");
  }
  if (!sql.trim().endsWith("COMMIT;")) {
    errors.push("El archivo no termina en COMMIT — parece incompleto o truncado.");
  }

  const statements = splitSqlStatements(sql);
  const createCount = statements.filter((s) => /^CREATE TABLE/i.test(s)).length;
  if (manifest && createCount !== Object.keys(manifest.tablas).length) {
    errors.push(
      `El número de tablas (${createCount}) no coincide con los metadatos del backup (${Object.keys(manifest.tablas).length}).`,
    );
  }

  if (manifest) {
    const insertCounts: Record<string, number> = {};
    for (const s of statements) {
      const m = s.match(/^INSERT INTO (\S+)/i);
      if (m) insertCounts[m[1]] = (insertCounts[m[1]] ?? 0) + 1;
    }
    for (const [table, count] of Object.entries(manifest.tablas)) {
      const actual = insertCounts[table] ?? 0;
      if (actual !== count) {
        errors.push(`La tabla "${table}" tiene ${actual} filas en el archivo; se esperaban ${count}.`);
      }
    }
  }

  return { ok: errors.length === 0, manifest, errors, statementCount: statements.length };
}

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

export async function gzipText(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export async function gunzipToText(bytes: BlobPart): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return new TextDecoder().decode(buf);
}

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export function backupFileName(prefix = "clio"): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const fecha = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const hora = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}_${fecha}_${hora}.sql.gz`;
}
