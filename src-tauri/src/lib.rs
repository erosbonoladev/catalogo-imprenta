/// Hashes a section password (e.g. for the Plásticos/Imprenta private info)
/// so the plaintext is never stored in the database.
#[tauri::command]
fn hash_password(password: String) -> Result<String, String> {
    bcrypt::hash(password, bcrypt::DEFAULT_COST).map_err(|e| e.to_string())
}

#[tauri::command]
fn verify_password(password: String, hash: String) -> Result<bool, String> {
    bcrypt::verify(password, &hash).map_err(|e| e.to_string())
}

/// Extiende el scope de `fs` en runtime para un único path que el usuario
/// acaba de elegir en un diálogo nativo (open/save) — reemplaza el scope
/// estático de todo `$HOME` que tenía la app antes. Se llama justo después
/// de cada diálogo, nunca con un path arbitrario construido a mano en JS.
/// Rechaza paths relativos o con segmentos `..` como defensa adicional,
/// aunque un path devuelto por el diálogo del SO ya viene absoluto y limpio.
#[tauri::command]
fn allow_fs_path(app: tauri::AppHandle, path: String, is_dir: bool) -> Result<(), String> {
    use std::path::{Component, Path};
    use tauri_plugin_fs::FsExt;

    let candidate = Path::new(&path);
    if !candidate.is_absolute() {
        return Err("Ruta rechazada: no es absoluta.".into());
    }
    if candidate.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("Ruta rechazada: contiene un segmento '..'.".into());
    }

    let scope = app.fs_scope();
    let result = if is_dir {
        // No recursivo: solo el nivel superior de la carpeta, que es lo
        // único que la importación masiva de imágenes necesita leer.
        scope.allow_directory(&path, false)
    } else {
        scope.allow_file(&path)
    };
    result.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            hash_password,
            verify_password,
            allow_fs_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
