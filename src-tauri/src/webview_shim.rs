//! Micrófono en el webview: WebKitGTK niega getUserMedia por default y wry no
//! conecta el signal `permission-request`. Sin este shim, el micrófono del
//! escritorio Linux falla con NotAllowedError aunque el SO ande perfecto.
//! Adaptado de lemonade `webview_shim.rs` (solo parte mic, sin opener).
//! Ref: .audit/referentes/REFERENTES.md §4.

use tauri::WebviewWindow;

/// Llamar una vez desde setup() con cada ventana que use micrófono.
pub(crate) fn apply(window: &WebviewWindow) {
    #[cfg(target_os = "linux")]
    if let Err(err) = window.with_webview(install_linux_shim) {
        log::warn!("webview_shim: no se pudo instalar: {err}");
    }
    #[cfg(not(target_os = "linux"))]
    let _ = window;
}

#[cfg(target_os = "linux")]
fn install_linux_shim(webview: tauri::webview::PlatformWebview) {
    use glib::object::Cast;
    use webkit2gtk::{PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, WebViewExt};

    let wv = webview.inner();

    // WebRTC/getUserMedia vienen OFF en el WebView de Tauri.
    if let Some(settings) = wv.settings() {
        settings.set_enable_media_stream(true);
        settings.set_enable_mediasource(true);
        settings.set_enable_webrtc(true);
    }

    // El webview solo carga contenido local embebido: otorgar mic/cámara.
    wv.connect_permission_request(|_wv, request| {
        if request.clone().downcast::<UserMediaPermissionRequest>().is_ok() {
            eprintln!("[shim] getUserMedia otorgado al webview");
            request.allow();
            true
        } else {
            false
        }
    });
}
