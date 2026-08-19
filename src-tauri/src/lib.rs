use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create_products_tables",
            sql: r#"
                CREATE TABLE products (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    codigo TEXT NOT NULL UNIQUE,
                    nombre TEXT NOT NULL,
                    categoria TEXT NOT NULL DEFAULT '',
                    material TEXT NOT NULL DEFAULT '',
                    descripcion TEXT NOT NULL DEFAULT '',
                    imagen TEXT,
                    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE product_specs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
                    etiqueta TEXT NOT NULL,
                    valor TEXT NOT NULL,
                    orden INTEGER NOT NULL DEFAULT 0
                );

                CREATE INDEX idx_products_codigo ON products(codigo);
                CREATE INDEX idx_products_nombre ON products(nombre);
                CREATE INDEX idx_specs_product_id ON product_specs(product_id);
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "seed_example_products",
            sql: r#"
                INSERT INTO products (codigo, nombre, categoria, material, descripcion, imagen) VALUES
                ('3072', 'Tangram', 'Juegos didácticos', 'Plástico', 'Rompecabezas geométrico de 7 piezas fabricado en acrílico de color, corte láser.', NULL),
                ('3073', 'Tangram', 'Juegos didácticos', 'Madera', 'Rompecabezas geométrico de 7 piezas fabricado en MDF de 3mm, corte láser y grabado.', NULL);

                INSERT INTO product_specs (product_id, etiqueta, valor, orden) VALUES
                (1, 'Dimensiones', '15 x 15 cm', 1),
                (1, 'Espesor', '3 mm', 2),
                (1, 'Piezas', '7', 3),
                (1, 'Técnica', 'Corte láser', 4),
                (1, 'Colores disponibles', 'Rojo, Azul, Verde, Amarillo, Transparente', 5),
                (2, 'Dimensiones', '15 x 15 cm', 1),
                (2, 'Espesor', '3 mm', 2),
                (2, 'Piezas', '7', 3),
                (2, 'Técnica', 'Corte láser y grabado', 4),
                (2, 'Acabado', 'Madera natural, sin pintar', 5);
            "#,
            kind: MigrationKind::Up,
        },
    ]
}

/// Copies a user-picked image file into the app's data directory so the
/// catalog keeps working even if the original file is later moved or deleted.
/// Returns the stored file's name (not full path) to persist in the database.
#[tauri::command]
fn guardar_imagen_producto(
    app: tauri::AppHandle,
    ruta_origen: String,
    codigo: String,
) -> Result<String, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let images_dir = app_data_dir.join("images");
    fs::create_dir_all(&images_dir).map_err(|e| e.to_string())?;

    let origen = PathBuf::from(&ruta_origen);
    let extension = origen
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();

    let nombre_archivo = format!("{}_{}.{}", codigo, timestamp, extension);
    let destino = images_dir.join(&nombre_archivo);

    fs::copy(&origen, &destino).map_err(|e| e.to_string())?;

    Ok(nombre_archivo)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:imprenta.db", migrations())
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![guardar_imagen_producto])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
