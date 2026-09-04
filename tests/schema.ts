/**
 * Esquema mínimo para pruebas de integridad — reconstruido a mano a partir
 * de docs/DATABASE.md, ya que no existe un script de bootstrap completo en
 * el repo (el esquema real se creó con un script one-off que no quedó
 * versionado). Si se agrega una tabla/columna real vía un futuro
 * scripts/add-*.mjs, este archivo debe actualizarse también — es la fuente
 * de verdad solo para pruebas, no para producción.
 */
export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT UNIQUE NOT NULL,
    nombre TEXT NOT NULL,
    categoria TEXT,
    material TEXT,
    descripcion TEXT,
    imagen BLOB,
    imagen_mime TEXT,
    imagen_codigo_barras BLOB,
    imagen_codigo_barras_mime TEXT,
    presentacion_original TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now')),
    actualizado_en TEXT
  )`,
  `CREATE TABLE pending_product_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT NOT NULL UNIQUE,
    imagen BLOB NOT NULL,
    imagen_mime TEXT NOT NULL,
    archivo_original TEXT,
    creado_por TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE product_specs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    etiqueta TEXT NOT NULL,
    valor TEXT NOT NULL,
    orden INTEGER NOT NULL DEFAULT 1,
    permite_requisicion INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE product_descriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    etiqueta TEXT NOT NULL,
    texto TEXT NOT NULL,
    orden INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE plastic_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    sku TEXT,
    color TEXT,
    origen TEXT,
    descripcion TEXT,
    armado TEXT,
    dimension TEXT,
    peso TEXT,
    tipo_empaque TEXT,
    maquila TEXT,
    coste TEXT,
    imagen BLOB,
    imagen_mime TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // Tabla muerta (ver docs/DATABASE.md "Tablas y columnas muertas") —
  // reemplazada por plastic_products/product_plastic_items, pero sigue
  // existiendo físicamente en producción (BD compartida en vivo, no se
  // borra) y deleteProduct todavía hace un DELETE sobre ella como parte de
  // su cascada — se incluye aquí solo para que ese statement, ya existente
  // y sin cambios, no falle contra el esquema de prueba.
  `CREATE TABLE product_plastic_pieces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL
  )`,
  `CREATE TABLE product_plastic_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    plastic_product_id INTEGER NOT NULL,
    orden INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE product_print_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    nombre TEXT,
    tamano TEXT,
    tipo_papel TEXT,
    tintas TEXT,
    gramos_puntos TEXT,
    pliego TEXT,
    extendido TEXT,
    corte_cm TEXT,
    maquina TEXT,
    formacion TEXT,
    numero_pliegos TEXT,
    numero_placas TEXT,
    placas_existentes TEXT,
    acabados TEXT,
    notas TEXT,
    orden INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE product_print_item_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    print_item_id INTEGER NOT NULL,
    nombre TEXT NOT NULL,
    marcado INTEGER NOT NULL DEFAULT 0,
    orden INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE product_print_item_extras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    print_item_id INTEGER NOT NULL,
    etiqueta TEXT,
    valor TEXT,
    orden INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE product_print_item_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    print_item_id INTEGER NOT NULL,
    imagen BLOB,
    imagen_mime TEXT,
    orden INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE product_print_item_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    print_item_id INTEGER NOT NULL,
    merma REAL,
    cantidad_arte REAL,
    numero_tiros REAL,
    formacion_usada REAL,
    numero_pliegos_usado REAL,
    total_pliegos REAL,
    usuario TEXT,
    folio TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE product_print_item_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    print_item_order_id INTEGER NOT NULL,
    papel TEXT,
    pliego TEXT,
    maquina TEXT,
    cortes REAL,
    cantidad REAL,
    total_tamanos REAL,
    usuario TEXT,
    folio TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    activo INTEGER NOT NULL DEFAULT 1,
    rol TEXT NOT NULL DEFAULT 'usuario',
    creado_en TEXT NOT NULL DEFAULT (datetime('now')),
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    session_token TEXT,
    session_expires_at TEXT,
    backup_local_diario INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE user_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    permiso TEXT NOT NULL
  )`,
  `CREATE TABLE user_sessions (
    user_id INTEGER PRIMARY KEY,
    last_seen TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE app_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nivel TEXT NOT NULL,
    mensaje TEXT NOT NULL,
    usuario TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // folio se inserta en NULL a propósito y se llena con un UPDATE aparte
  // (insertFolioRow en db.ts arma el string del folio con el id ya
  // generado) — no puede ser NOT NULL.
  `CREATE TABLE folios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seccion TEXT NOT NULL,
    consecutivo INTEGER NOT NULL,
    folio TEXT,
    sku TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE requisiciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER,
    fecha TEXT NOT NULL,
    numero_dia INTEGER NOT NULL,
    usuario TEXT,
    etiqueta TEXT,
    descripcion TEXT,
    cantidad REAL,
    estado TEXT NOT NULL DEFAULT 'pendiente',
    mensaje TEXT,
    folio TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE backup_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    origen TEXT,
    usuario TEXT,
    archivo TEXT,
    ubicacion TEXT,
    tamano_bytes INTEGER,
    checksum_sha256 TEXT,
    estado TEXT NOT NULL,
    detalle TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE backup_settings (
    id INTEGER PRIMARY KEY,
    automatico_activado INTEGER NOT NULL DEFAULT 0,
    frecuencia TEXT,
    hora_ejecucion TEXT,
    intervalo_horas INTEGER,
    dia_semana INTEGER,
    retencion_diaria_dias INTEGER,
    retencion_semanal_dias INTEGER,
    retencion_mensual_dias INTEGER,
    ultimo_automatico_en TEXT,
    actualizado_en TEXT,
    actualizado_por TEXT
  )`,
  `CREATE TABLE precios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT UNIQUE NOT NULL,
    sku_principal TEXT NOT NULL,
    nombre TEXT NOT NULL,
    precio REAL NOT NULL,
    actualizado_en TEXT NOT NULL DEFAULT (datetime('now')),
    actualizado_por TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now')),
    tipo TEXT
  )`,
  `CREATE TABLE precios_historial (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT NOT NULL,
    precio_anterior REAL,
    precio_nuevo REAL NOT NULL,
    usuario TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE remisiones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folio TEXT NOT NULL,
    fecha TEXT NOT NULL,
    tipo TEXT NOT NULL,
    pedido_bodegas TEXT,
    cancelada INTEGER NOT NULL DEFAULT 0,
    subtotal REAL NOT NULL,
    descuento_pct REAL NOT NULL DEFAULT 0,
    descuento REAL NOT NULL DEFAULT 0,
    iva REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL,
    precio_texto TEXT,
    usuario TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE remision_renglones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    remision_id INTEGER NOT NULL,
    numero_renglon INTEGER NOT NULL,
    sku TEXT,
    producto_nombre TEXT,
    cantidad REAL NOT NULL,
    precio_unitario REAL NOT NULL,
    importe REAL NOT NULL
  )`,
  // No es una tabla real de Clio — existe solo para que backups.test.ts
  // pueda ejercer un ciclo completo DROP TABLE IF EXISTS / CREATE TABLE /
  // INSERT INTO de executeRestoreSql sin pisar el esquema de una tabla de
  // la que dependan otras pruebas.
  `CREATE TABLE test_scratch (
    id INTEGER PRIMARY KEY,
    valor TEXT
  )`,
];
