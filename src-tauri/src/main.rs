// Equipo Desktop — núcleo Tauri: bandeja, orbe, sidecar Node, permisos por
// niveles (permitir/preguntar/bloquear, estilo opencode), captura de pantalla
// (xcap) y control de mouse/teclado (enigo). Todo texto visible, en español.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod webview_shim;

use std::collections::HashMap;
use std::fs;
use std::io::Cursor;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine as _;
use enigo::{Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use image::ImageFormat;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const CAPS: [&str; 3] = ["pantalla", "mouse", "teclado"];
const LEVELS: [&str; 3] = ["permitir", "preguntar", "bloquear"];
const APPROVAL_TTL_SECS: u64 = 120;
const ORB_W: i32 = 200;
const ORB_H: i32 = 264;
const ORB_MARGIN: i32 = 24;

struct Sidecar {
    child: Option<Child>,
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
        }
    }
}

#[derive(Clone, serde::Serialize)]
struct EstadoOrbe {
    estado: String,
    nivel: f32,
}

struct Estado {
    backend_url: Mutex<String>,
    // RAII: nunca se lee; retener el Child mantiene vivo el sidecar y Drop lo mata.
    #[allow(dead_code)]
    sidecar: Mutex<Sidecar>,
    permisos: Mutex<HashMap<String, String>>,
    aprobaciones: Mutex<HashMap<String, (String, Instant)>>,
    orbe: Mutex<EstadoOrbe>,
    cmd_orbe: Mutex<Option<String>>,
    // TG orbe-mini: true si el orbe está visible PORQUE main se minimizó.
    // Lo usa main_restored para ocultar solo ese orbe (el manual/hotkey
    // se queda). Env Mutex como el resto: un bool no necesita AtomicBool
    // con este tráfico (1 chequeo cada 500ms).
    orb_por_minimizar: Mutex<bool>,
    datos: PathBuf,
}

fn load_perms(datos: &PathBuf) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = CAPS
        .iter()
        .map(|c| (c.to_string(), "preguntar".to_string()))
        .collect();
    if let Ok(txt) = fs::read_to_string(datos.join("permisos.json")) {
        if let Ok(saved) = serde_json::from_str::<HashMap<String, String>>(&txt) {
            for (k, v) in saved {
                if CAPS.contains(&k.as_str()) && LEVELS.contains(&v.as_str()) {
                    out.insert(k, v);
                }
            }
        }
    }
    out
}

fn save_perms(datos: &PathBuf, permisos: &HashMap<String, String>) {
    let _ = fs::write(
        datos.join("permisos.json"),
        serde_json::to_string_pretty(permisos).unwrap_or_default(),
    );
}

fn check(
    estado: &tauri::State<Estado>,
    cap: &str,
    approval: Option<String>,
) -> Result<(), String> {
    let nivel = estado
        .permisos
        .lock()
        .map_err(|_| "permisos bloqueados".to_string())?
        .get(cap)
        .cloned()
        .unwrap_or_else(|| "preguntar".to_string());
    match nivel.as_str() {
        "permitir" => Ok(()),
        "bloquear" => Err("bloqueado en tus permisos (Ajustes → Computadora)".to_string()),
        _ => {
            let token = approval.unwrap_or_default();
            let mut mapa = estado
                .aprobaciones
                .lock()
                .map_err(|_| "permisos bloqueados".to_string())?;
            match mapa.remove(&token) {
                Some((c, expira)) if c == cap && expira > Instant::now() => Ok(()),
                _ => Err("APPROVAL_REQUIRED".to_string()),
            }
        }
    }
}

fn enigo() -> Result<Enigo, String> {
    Enigo::new(&Settings::default()).map_err(|e| format!("enigo: {e}"))
}

fn parse_key(k: &str) -> Option<Key> {
    match k.to_lowercase().as_str() {
        "enter" => Some(Key::Return),
        "tab" => Some(Key::Tab),
        "escape" | "esc" => Some(Key::Escape),
        "backspace" => Some(Key::Backspace),
        "delete" | "supr" => Some(Key::Delete),
        "up" => Some(Key::UpArrow),
        "down" => Some(Key::DownArrow),
        "left" => Some(Key::LeftArrow),
        "right" => Some(Key::RightArrow),
        "home" => Some(Key::Home),
        "end" => Some(Key::End),
        "pageup" => Some(Key::PageUp),
        "pagedown" => Some(Key::PageDown),
        "space" | " " => Some(Key::Space),
        "f1" => Some(Key::F1),
        "f2" => Some(Key::F2),
        "f3" => Some(Key::F3),
        "f4" => Some(Key::F4),
        "f5" => Some(Key::F5),
        "f6" => Some(Key::F6),
        "f7" => Some(Key::F7),
        "f8" => Some(Key::F8),
        "f9" => Some(Key::F9),
        "f10" => Some(Key::F10),
        "f11" => Some(Key::F11),
        "f12" => Some(Key::F12),
        s if s.chars().count() == 1 => s.chars().next().map(Key::Unicode),
        _ => None,
    }
}

#[derive(serde::Serialize)]
struct Captura {
    data: String,
    width: u32,
    height: u32,
}

#[tauri::command]
fn capture_screen(
    estado: tauri::State<Estado>,
    approval: Option<String>,
) -> Result<Captura, String> {
    check(&estado, "pantalla", approval)?;
    let monitores = xcap::Monitor::all().map_err(|e| format!("monitores: {e}"))?;
    let mon = monitores.into_iter().next().ok_or("sin monitores")?;
    let img = mon.capture_image().map_err(|e| format!("captura: {e}"))?;
    // Vía píxeles crudos: no depende de la versión exacta del crate image
    // que traiga xcap por dentro.
    let (w, h) = (img.width(), img.height());
    let crudo = img.into_raw();
    let dinamica = image::DynamicImage::ImageRgba8(
        image::RgbaImage::from_raw(w, h, crudo).ok_or("raw inválido")?,
    );
    let chica = dinamica.thumbnail(1280, 800);
    let mut buf = Cursor::new(Vec::new());
    chica
        .write_to(&mut buf, ImageFormat::Png)
        .map_err(|e| format!("png: {e}"))?;
    Ok(Captura {
        data: base64::engine::general_purpose::STANDARD.encode(buf.get_ref()),
        width: chica.width(),
        height: chica.height(),
    })
}

#[tauri::command]
fn mouse_move(
    estado: tauri::State<Estado>,
    x: i32,
    y: i32,
    approval: Option<String>,
) -> Result<(), String> {
    check(&estado, "mouse", approval)?;
    enigo()?
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| format!("mouse: {e}"))
}

#[tauri::command]
fn mouse_click(
    estado: tauri::State<Estado>,
    button: String,
    approval: Option<String>,
) -> Result<(), String> {
    check(&estado, "mouse", approval)?;
    let boton = match button.as_str() {
        "right" | "derecho" => Button::Right,
        "middle" | "medio" => Button::Middle,
        _ => Button::Left,
    };
    enigo()?
        .button(boton, Direction::Click)
        .map_err(|e| format!("clic: {e}"))
}

#[tauri::command]
fn key_press(
    estado: tauri::State<Estado>,
    key: String,
    approval: Option<String>,
) -> Result<(), String> {
    check(&estado, "teclado", approval)?;
    let tecla = parse_key(&key).ok_or_else(|| format!("tecla desconocida: {key}"))?;
    enigo()?
        .key(tecla, Direction::Click)
        .map_err(|e| format!("tecla: {e}"))
}

#[tauri::command]
fn type_text(
    estado: tauri::State<Estado>,
    text: String,
    approval: Option<String>,
) -> Result<(), String> {
    check(&estado, "teclado", approval)?;
    if text.chars().count() > 2000 {
        return Err("texto muy largo (máx 2000)".to_string());
    }
    enigo()?.text(&text).map_err(|e| format!("texto: {e}"))
}

#[tauri::command]
fn get_permissions(estado: tauri::State<Estado>) -> HashMap<String, String> {
    estado
        .permisos
        .lock()
        .map(|m| m.clone())
        .unwrap_or_default()
}

#[tauri::command]
fn set_permission(
    estado: tauri::State<Estado>,
    cap: String,
    level: String,
) -> Result<(), String> {
    if !CAPS.contains(&cap.as_str()) {
        return Err("capacidad desconocida".to_string());
    }
    if !LEVELS.contains(&level.as_str()) {
        return Err("nivel desconocido".to_string());
    }
    match estado.permisos.lock() {
        Ok(mut m) => {
            m.insert(cap, level);
            save_perms(&estado.datos, &m);
            Ok(())
        }
        Err(_) => Err("permisos bloqueados".to_string()),
    }
}

#[tauri::command]
fn approve_once(estado: tauri::State<Estado>, cap: String) -> Result<String, String> {
    if !CAPS.contains(&cap.as_str()) {
        return Err("capacidad desconocida".to_string());
    }
    let token = uuid::Uuid::new_v4().to_string();
    match estado.aprobaciones.lock() {
        Ok(mut m) => {
            m.insert(
                token.clone(),
                (cap, Instant::now() + Duration::from_secs(APPROVAL_TTL_SECS)),
            );
            Ok(token)
        }
        Err(_) => Err("permisos bloqueados".to_string()),
    }
}

#[tauri::command]
fn backend_url(estado: tauri::State<Estado>) -> String {
    estado
        .backend_url
        .lock()
        .map(|u| u.clone())
        .unwrap_or_else(|_| "http://127.0.0.1:8787".to_string())
}

#[tauri::command]
fn app_platform() -> String {
    std::env::consts::OS.to_string()
}

fn show_main_inner(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        // TG: restaurar también des-minimiza (la taskbar/bandeja/⤢ del
        // orbe deben traer la ventana de vuelta aunque esté minimizada).
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// TG orbe-mini: apaga la marca "orbe por minimizar" (override manual:
// si el usuario ocultó el orbe a mano, restore no lo toca).
fn clear_min_flag(app: &AppHandle) {
    if let Ok(mut guard) = app.state::<Estado>().orb_por_minimizar.try_lock() {
        *guard = false;
    }
}

fn place_orb(app: &AppHandle) {
    let Some(orb) = app.get_webview_window("orb") else {
        return;
    };
    if let Ok(Some(mon)) = orb.current_monitor() {
        let size = mon.size();
        let pos = mon.position();
        let x = pos.x + size.width as i32 - ORB_W - ORB_MARGIN;
        let y = pos.y + size.height as i32 - ORB_H - ORB_MARGIN;
        let _ = orb.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
    }
    let _ = orb.show();
}

fn toggle_orb_inner(app: &AppHandle) {
    if let Some(o) = app.get_webview_window("orb") {
        if o.is_visible().unwrap_or(false) {
            let _ = o.hide();
            clear_min_flag(app);
        } else {
            place_orb(app);
        }
    }
}

#[tauri::command]
fn show_main(app: AppHandle) {
    show_main_inner(&app);
}

#[tauri::command]
fn toggle_main(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(true) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

#[tauri::command]
fn toggle_orb(app: AppHandle) {
    toggle_orb_inner(&app);
}

#[tauri::command]
fn show_orb(app: AppHandle) {
    place_orb(&app);
}

#[tauri::command]
fn hide_orb(app: AppHandle) {
    if let Some(o) = app.get_webview_window("orb") {
        let _ = o.hide();
    }
    clear_min_flag(&app);
}

#[tauri::command]
fn expand_from_orb(app: AppHandle) {
    if let Some(o) = app.get_webview_window("orb") {
        let _ = o.hide();
    }
    clear_min_flag(&app);
    show_main_inner(&app);
}

// TG orbe-mini: el frontend main avisa transiciones de minimizado
// (Tauri 2 no expone evento minimized: se detecta con isMinimized()
// en el tick existente de 500ms, solo en transiciones).
#[tauri::command]
fn main_minimized(app: AppHandle) {
    let minimizada = app
        .get_webview_window("main")
        .and_then(|w| w.is_minimized().ok())
        .unwrap_or(false);
    if !minimizada {
        return;
    }
    place_orb(&app);
    if let Ok(mut guard) = app.state::<Estado>().orb_por_minimizar.try_lock() {
        *guard = true;
    }
}

#[tauri::command]
fn main_restored(app: AppHandle) {
    let main_ok = app.get_webview_window("main").map(|w| {
        let min = w.is_minimized().unwrap_or(true);
        let vis = w.is_visible().unwrap_or(false);
        !min && vis
    });
    if main_ok != Some(true) {
        return;
    }
    let era_por_minimizar = app
        .state::<Estado>()
        .orb_por_minimizar
        .try_lock()
        .map(|mut guard| {
            let era = *guard;
            *guard = false;
            era
        })
        .unwrap_or(false);
    if era_por_minimizar {
        if let Some(o) = app.get_webview_window("orb") {
            let _ = o.hide();
        }
    }
}

#[tauri::command]
fn orb_drag(win: tauri::WebviewWindow) {
    let _ = win.start_dragging();
}

#[tauri::command]
fn orb_poll(estado: tauri::State<Estado>) -> EstadoOrbe {
    estado
        .orbe
        .lock()
        .map(|o| o.clone())
        .unwrap_or(EstadoOrbe {
            estado: "idle".to_string(),
            nivel: 0.0,
        })
}

#[tauri::command]
fn orb_report(estado: tauri::State<Estado>, nuevo: String, nivel: f32) {
    if let Ok(mut o) = estado.orbe.lock() {
        o.estado = match nuevo.as_str() {
            "escuchando" | "hablando" | "pensando" => nuevo,
            _ => "idle".to_string(),
        };
        o.nivel = nivel.clamp(0.0, 1.0);
    }
}

#[tauri::command]
fn orb_command(app: AppHandle, estado: tauri::State<Estado>, cmd: String) {
    if cmd == "expand" {
        expand_from_orb(app);
        return;
    }
    if let Ok(mut slot) = estado.cmd_orbe.lock() {
        *slot = Some(cmd);
    }
}

#[tauri::command]
fn main_poll(estado: tauri::State<Estado>) -> Option<String> {
    estado.cmd_orbe.lock().ok().and_then(|mut s| s.take())
}

fn spawn_sidecar(app: &AppHandle, datos: &PathBuf) -> (String, Option<Child>) {
    let fallback = "http://127.0.0.1:8787".to_string();
    // Tauri 2 pone el externalBin junto al ejecutable y recorta el triple.
    // Se llama equipo-node para no chocar con el node del sistema (/usr/bin/node).
    let exe_nombre = if cfg!(windows) {
        "equipo-node.exe"
    } else {
        "equipo-node"
    };
    let node = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.join(exe_nombre)))
        .filter(|p| p.is_file());
    let node = match node {
        Some(p) => p,
        None => return (fallback, None),
    };
    // Los recursos con `..` en tauri.conf se mapean a `_up_` (verificado en
    // el .deb: usr/lib/Equipo/_up_/server). Se prueban ambos por si cambia.
    let rd = match app.path().resource_dir() {
        Ok(d) => d,
        Err(_) => return (fallback, None),
    };
    let entry = [rd.join("_up_").join("server"), rd.join("server")]
        .into_iter()
        .map(|d| d.join("index.js"))
        .find(|p| p.is_file());
    let entry = match entry {
        Some(p) => p,
        None => return (fallback, None),
    };
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok().map(|a| a.port()))
        .unwrap_or(8787);
    let mut cmd = Command::new(&node);
    cmd.arg(&entry)
        .env("PORT", port.to_string())
        .env("HOST", "127.0.0.1")
        .env("DB_PATH", datos.join("meetings.db"))
        .env("WORKSPACE_ROOT", datos.join("workspace"))
        .stdin(Stdio::null());
    match fs::File::create(datos.join("server.log")) {
        Ok(f) => {
            let f2 = f.try_clone().ok();
            cmd.stdout(Stdio::from(f));
            if let Some(g) = f2 {
                cmd.stderr(Stdio::from(g));
            }
        }
        Err(_) => {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return (fallback, None),
    };
    for _ in 0..100 {
        let addr: Option<std::net::SocketAddr> =
            format!("127.0.0.1:{port}").parse().ok();
        if let Some(a) = addr {
            if TcpStream::connect_timeout(&a, Duration::from_millis(200)).is_ok() {
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    (format!("http://127.0.0.1:{port}"), Some(child))
}

fn main() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        toggle_orb_inner(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let datos = app.path().app_data_dir()?;
            fs::create_dir_all(&datos)?;
            let permisos = load_perms(&datos);
            let (url, child) = if cfg!(debug_assertions) {
                ("http://127.0.0.1:8787".to_string(), None)
            } else {
                spawn_sidecar(app.handle(), &datos)
            };
            app.manage(Estado {
                backend_url: Mutex::new(url),
                sidecar: Mutex::new(Sidecar { child }),
                permisos: Mutex::new(permisos),
                aprobaciones: Mutex::new(HashMap::new()),
                orbe: Mutex::new(EstadoOrbe {
                    estado: "idle".to_string(),
                    nivel: 0.0,
                }),
                cmd_orbe: Mutex::new(None),
                orb_por_minimizar: Mutex::new(false),
                datos,
            });

            // Micrófono en Linux: otorga getUserMedia al webview main.
            if let Some(main) = app.get_webview_window("main") {
                webview_shim::apply(&main);
            }

            let mostrar = MenuItem::with_id(app, "mostrar", "Mostrar Equipo", true, None::<&str>)?;
            let orbe =
                MenuItem::with_id(app, "orbe", "Mostrar/ocultar orbe", true, None::<&str>)?;
            let salir = MenuItem::with_id(app, "salir", "Salir", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&mostrar, &orbe, &salir])?;
            let icono = app
                .default_window_icon()
                .cloned()
                .or_else(|| {
                    tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png")).ok()
                })
                .ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::NotFound, "sin icono")
                })?;
            TrayIconBuilder::new()
                .icon(icono)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("Equipo — tu equipo IA")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "mostrar" => show_main_inner(app),
                    "orbe" => toggle_orb_inner(app),
                    "salir" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button,
                        button_state,
                        ..
                    } = event
                    {
                        if button == MouseButton::Left && button_state == MouseButtonState::Up {
                            show_main_inner(tray.app_handle());
                        }
                    }
                })
                .build(app)?;

            if let Some(main) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                main.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.hide();
                        }
                        place_orb(&handle);
                    }
                });
            }

            let atajo = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyE);
            app.global_shortcut().register(atajo)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend_url,
            app_platform,
            show_main,
            toggle_main,
            toggle_orb,
            show_orb,
            hide_orb,
            expand_from_orb,
            main_minimized,
            main_restored,
            orb_drag,
            orb_poll,
            orb_report,
            orb_command,
            main_poll,
            get_permissions,
            set_permission,
            approve_once,
            capture_screen,
            mouse_move,
            mouse_click,
            key_press,
            type_text
        ])
        .run(tauri::generate_context!())
        .expect("error al arrancar Equipo");
}
