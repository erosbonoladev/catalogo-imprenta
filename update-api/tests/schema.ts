// Esquema mínimo para las pruebas de integridad de este Worker: dos bases
// separadas en disco, igual que en producción (ver dbClients.ts) —
// LICENSING_SCHEMA para installation_credentials/installations/audit_logs,
// MAIN_SCHEMA para el subconjunto de la base principal que assertActorAuthorized
// necesita leer (users/user_permissions, copiado de tests/schema.ts en la
// raíz del repo — mantener en sync si esas columnas cambian ahí).

export const LICENSING_SCHEMA_STATEMENTS = [
  `CREATE TABLE installation_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_hash TEXT NOT NULL UNIQUE,
    code_preview TEXT NOT NULL,
    sede_codigo TEXT NOT NULL,
    sede_nombre TEXT NOT NULL,
    descripcion TEXT NOT NULL DEFAULT '',
    usuario_responsable TEXT,
    estado TEXT NOT NULL DEFAULT 'activa',
    installation_id INTEGER,
    creado_por TEXT NOT NULL,
    creado_en TEXT NOT NULL DEFAULT (datetime('now')),
    usado_en TEXT
  )`,
  `CREATE TABLE installations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    installation_code TEXT NOT NULL UNIQUE,
    seq INTEGER NOT NULL,
    sede_codigo TEXT NOT NULL,
    sede_nombre TEXT NOT NULL,
    descripcion TEXT NOT NULL DEFAULT '',
    device_token_hash TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'activa',
    ultima_version TEXT,
    ultima_conexion_en TEXT,
    activada_en TEXT NOT NULL DEFAULT (datetime('now')),
    revocada_en TEXT,
    reactivada_en TEXT
  )`,
  `CREATE TABLE audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    accion TEXT NOT NULL,
    installation_id INTEGER,
    credential_id INTEGER,
    actor_username TEXT,
    detalle TEXT NOT NULL DEFAULT '',
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

export const MAIN_SCHEMA_STATEMENTS = [
  `CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    activo INTEGER NOT NULL DEFAULT 1,
    rol TEXT NOT NULL DEFAULT 'usuario',
    creado_en TEXT NOT NULL DEFAULT (datetime('now')),
    session_token TEXT,
    session_expires_at TEXT
  )`,
  `CREATE TABLE user_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    permiso TEXT NOT NULL
  )`,
];
