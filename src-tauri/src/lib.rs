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

// --- Credencial de activación de instalación (ver docs/DISTRIBUTION.md) ---
//
// Guardada en el llavero nativo del SO (Keychain en macOS, Credential
// Manager en Windows) vía `keyring`, nunca en un archivo plano ni en
// localStorage — es lo único que autoriza a esta máquina a consultar el
// Update API. Un solo Entry por app (servicio = identifier de Tauri, cuenta
// fija "device_credential"): esta app solo tiene una instalación activa a
// la vez, no hace falta más de una entrada.

const KEYRING_SERVICE: &str = "com.mariat.catalogo-imprenta";
const KEYRING_ACCOUNT: &str = "device_credential";

#[derive(serde::Serialize, serde::Deserialize)]
struct DeviceCredential {
    installation_id: String,
    device_token: String,
    last_authorized_at: String,
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|e| e.to_string())
}

#[tauri::command]
fn store_device_credential(
    installation_id: String,
    device_token: String,
    last_authorized_at: String,
) -> Result<(), String> {
    let credential = DeviceCredential {
        installation_id,
        device_token,
        last_authorized_at,
    };
    let json = serde_json::to_string(&credential).map_err(|e| e.to_string())?;
    keyring_entry()?.set_password(&json).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_device_credential() -> Result<Option<DeviceCredential>, String> {
    match keyring_entry()?.get_password() {
        Ok(json) => serde_json::from_str(&json)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Solo para el flujo de troubleshooting/reactivación manual (reinstalar con
/// otro código de activación en la misma máquina) — nunca se llama
/// automáticamente por una revocación, que debe bloquear el uso sin borrar
/// nada local (ver docs/DISTRIBUTION.md).
#[tauri::command]
fn clear_device_credential() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            hash_password,
            verify_password,
            allow_fs_path,
            store_device_credential,
            load_device_credential,
            clear_device_credential
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
