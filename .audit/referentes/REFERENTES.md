# REFERENTES — Asistentes IA de escritorio con VOZ

Fecha: 2026-11-07 · Audit track "Repos / casos de éxito"
Stack objetivo: **Tauri 2 + frontend web + sidecar Node**

---

## 1) Tabla de proyectos (10)

| # | Proyecto | Link | Stars (nov-2026) | Qué patrón aporta |
|---|----------|------|------------------|-------------------|
| 1 | **openinterpreter / openinterpreter** | <https://github.com/openinterpreter/openinterpreter> | ~69k | El OG del computer-control por agentes: loop tool-use + system message dinámico + perfiles. Todo asistente de escritorio con acciones bebe de acá. |
| 2 | **openinterpreter / 01** | <https://github.com/openinterpreter/01> | ~5.2k | **La voz de Open Interpreter.** Servidor LiveKit (full) vs Light (ESP32); clientes desktop/móvil; push-to-talk con spacebar (hold→speak→release); protocolo LMC (mensajes con rol `computer`); WebSocket speech-to-speech `localhost:10001` con audio crudo. Docs: <https://01.openinterpreter.com/> |
| 3 | **isair / jarvis** | <https://github.com/isair/jarvis> | ~2.2k | **Desktop voice-first local-first más cercano a "producto".** Python + tray app, macOS/Win/Linux, corre offline con Ollama u OpenAI-compatible. Patrones: wake por nombre en cualquier parte de la frase, *rolling context* corto (asistente "tercera persona en la sala"), **redacción de spans sensibles antes de persistir memoria**, dictación + MCP tools sin context-rot. Review: <https://hysenlabs.com/projects/isair-jarvis> |
| 4 | **mbailey / voicemode** | <https://github.com/mbailey/voicemode> | — (2.3k commits, PyPI `voice-mode`) | Voz para Claude Code vía **MCP** (`/voicemode:converse`). Servicios locales opcionales: **Whisper STT + Kokoro TTS**; silence-detection auto-stop; fallback OpenAI API. Patrón instalador: `uvx voice-mode-install` + `claude mcp add`. Forks activos: `gkusmierz/claude-code-voice-mode`, `syntax-syndicate/claude-code-voice-mode`. |
| 5 | **dburks-svg / lyns-voice** | <https://github.com/dburks-svg/lyns-voice> | nuevo | **⭐ EL referente #1 para nosotros: Tauri v2 + voz + orb.** Orbe holográfico Three.js con 4 estados (Idle/Listening/Thinking/Speaking) + mood tint; HUD 3 columnas; STT = webview captura mic → worker Rust `whisper-rs` + `webrtc-vad` endpointing; TTS = comando Rust in-process **Kokoro vía ort/ONNX + misaki-rs G2P** (o SAPI nativo); sidecar `claude CLI --print --input-format stream-json`; wake word "Oracle" on-device; **barge-in con Escape** (+ speak-over opt-in); **PiP 180×180 always-on-top** con Alt+M; mic osciloscopio "am I being heard"; descarga resumable de modelos en first-run; footprint ~600-800 MB con ambos motores warm. |
| 6 | **ggml-org / whisper.cpp** | <https://github.com/ggml-org/whisper.cpp> | ~hito (ecosistema ggml) | Motor STT local: C/C++, GPU (CUDA/Metal/Vulkan), API C, ejemplos `whisper-stream` (mic realtime), `whisper-command` (voice assistant mínimo), `whisper-server` (HTTP OAI-like), soporte **VAD (`--vad` + modelo Silero)** y ports WASM (`stream.wasm` = mic en browser). |
| 7 | **Home Assistant Wyoming: openWakeWord + faster-whisper + Piper** | <https://www.bigiron.cc/guides/self-hosted-voice-assistant-pipeline-stt-vad-llm-tts-wake-word> · <https://github.com/rhasspy/rhasspy3> | ecosistema | **El pipeline local de referencia más probado del mundo** (miles de instalaciones HA Voice). 5 etapas como servicios Wyoming independientes y swappable: wake → VAD → STT → intent/LLM → TTS. Puertos: `:10400` oWW, `:10300` whisper, `:10200` piper. Rhasspy3 (MIT) documenta el loop completo mic→wake→asr→vad→intent→handle→tts→snd. |
| 8 | **envosloth / aria-voice** | <https://github.com/envosloth/aria-voice> | nuevo | Electron+Node en Linux con **latencias medidas y publicadas** (ver §3): whisper.cpp/Vulkan STT + Piper/Kokoro TTS + openWakeWord/Silero, sidecars Python por etapa vía UDS/PCM, `npm run smoke:e2e` con latency report. Espejo directo de nuestra arquitectura (ellos Electron, nosotros Tauri). |
| 9 | **LiveKit Agents** | <https://docs.livekit.io/agents/logic/turns/adaptive-interruption-handling/> · <https://docs.livekit.io/agents/build/turn-detection> | ecosistema | **Estado del arte en turn-taking open-source**: modelo *adaptive interruption* (barge-in acústico, no espera transcript), `TurnDetector` open-weights multilingüe, `Silero VAD`, cooldowns `backchannel_boundary=(1.0, 1.0)`, `false_interruption_timeout=2.0s`, métricas de latencia por barge-in. SDK Python + Node. |
| 10 | **sobol-sudo / tauri-overlay-demo** | <https://github.com/sobol-sudo/tauri-overlay-demo> | demo | **Receta Tauri 2 de overlay always-on-top**: ventana frameless translúcida + `global shortcut` + click-through + `CloseRequested→hide` + tray como única salida + stream de respuestas por WebSocket. Fin de semana de código, justo lo que necesitamos copiar. |

### Menciones cortas (distribución desktop, no voz)

- **Jan** (~45k ⭐, Apache-2.0, <https://github.com/janhq/jan>) — desktop chat local/cloud, el patrón de "descargá el modelo dentro de la app".
- **LibreChat** (~47k ⭐, MIT, <https://www.librechat.ai/>) — plataforma web/Docker multi-provider; sin desktop nativo ni voz, pero referencia de UX chat.
- **Cherry Studio** (~53k ⭐) / **AnythingLLM** (~68k ⭐) — clientes desktop multi-modelo; distribución por instalador.
- **screenpipe** (~22k ⭐) — grabación 24/7 pantalla+mic con transcripción local + MCP server; patrón "mic siempre abierto sin culpa" (todo on-device).
- **Venice AI** (privado, no open-source) — posicionamiento "private AI chat"; sirve como referencia de narrativa privacy-first, no de código.
- **rogerchappel/bargekit** (MIT, <https://github.com/rogerchappel/bargekit>) — SDK TS local-first de VAD + barge-in + duck/cancel hooks + fixtures sintéticas para tuning. Útil si el turn-taking vive en el frontend.
- **5ire / Leon / Khoj** — asistentes desktop open-source menores (5k/18k/38k ⭐); sin voz destacable.

---

## 2) Patrones de UX always-on

Recopilado de lyns-voice, 01, isair/jarvis, voicemode, tauri-overlay-demo, Hermes Agent.

### 2.1 Estados del avatar (lyns-voice — copiar tal cual)

Cuatro estados excluyentes con prioridad `speaking > listening > thinking > idle`, derivados de señales reales:

```ts
// seam mínima host-neutral (lyns-voice)
type VoiceSignals = { micActive: boolean; speaking: boolean; pendingResponse: boolean };
function deriveState(s: VoiceSignals) {
  if (s.speaking) return "speaking";        // core flarea por palabra
  if (s.micActive) return "listening";      // orbe energiza con nivel de mic
  if (s.pendingResponse) return "thinking"; // rotación rápida
  return "idle";                            // drift orbital lento
}
```

- **Mood layer**: el LLM emite `<<mood:NAME>>`, tiñe el orbe, se strippea antes de mostrar/hablar. Barato y con encanto.
- **Mic osciloscopio** bajo el control TAP TO TALK: feedback "me están escuchando" en vivo (Web Audio amplitude).

### 2.2 Push-to-talk vs wake word vs always-listening

| Modo | Quién lo usa | Detalle |
|------|--------------|---------|
| **Hold spacebar** | 01 (`poetry run 01` en desktop) | Hold → hablar → release. Cero falsos positivos, ideal default inicial. |
| **Tap to talk + auto-send en pausa** | lyns-voice, voicemode | VAD endpointing (webrtc-vad / Silero) finaliza el turno solo. `Space` togglea mic. |
| **Wake word on-device** | lyns-voice ("Oracle"), isair/jarvis (nombre en cualquier posición), Hermes ("Hey Hermes"), openWakeWord ("Hey Jarvis") | Mic abierto local, sin egress. Costo: ~5% de un core (oWW) o ~2ms/frame (Silero+oWW). Siempre **opt-in** con aviso explícito. |
| **Trigger word al enviar** | mcp-voice-hooks | Modo "esperar palabra gatillo" (ej. decir "send"/"claude"/"go" para mandar). Útil manos-libres sin VAD agresivo. |
| **Atajo global** | tauri-overlay-demo, Jarvis (hotkey), lyns-voice (Alt+T/D/J/N/S/M, Esc) | Mostrar/ocultar overlay desde cualquier app. Si el registro falla (otra app lo tiene), **log + seguir** — nunca crashear el arranque; el tray cubre las mismas acciones. Esc = barge-in/cerrar panel superior. Atajos suprimidos cuando hay foco en inputs/terminales. |

### 2.3 Overlay / PiP

- **Ventana overlay**: `transparent: true`, `decorations: false`, `alwaysOnTop: true`, `skipTaskbar: true`, `focus: false` inicial (lyns-voice widget 300×64 unfocused para que el auto-paste caiga en la app destino; tauri-overlay-demo añade click-through + protección anti-captura).
- **PiP mini-mode**: lyns-voice colapsa a **180×180 always-on-top** con solo el orbe (Alt+M / click restore). Es el "modo compañero" ideal.
- **Cierre = hide**: interceptar `CloseRequested` → ocultar, no salir. Quitar queda explícito en tray menu + Cmd+Q.
- **Notificaciones al background**: toast + taskbar flash cuando termina un turno con la app en segundo plano (lyns-voice).
- **First-run onboarding**: overlay único que explica los 4 estados + conexión del proyecto + descarga del modelo speech (con progreso y ETA, resumable).

### 2.4 Voz como ciudadano de segunda clase (a propósito)

- **El mic nunca es load-bearing** (lyns-voice): toda acción por voz tiene equivalente teclado/texto; compose box multilínea co-igual a la voz (Enter envía, Shift+Enter newline).
- **TTS detached**: el hook Stop de `MarcinSufa/claude-voice-mode` hace gate-check rápido y delega a un worker detached — la sesión nunca se bloquea sintetizando.
- **Daemon para modelos pesados**: `Null-Phnix/claude-voice` carga Kokoro una vez (~6-10s) y sirve por Unix socket; el hook por respuesta sería impagable en frío.

---

## 3) Pipelines de audio probados (STT/TTS, VAD, barge-in + latencias)

### 3.1 El pipeline canónico local

```
mic → [wake word] → VAD endpointing → STT → LLM/intent → TTS (sentence-chunked) → speaker
         │               │              │                    │
      openWakeWord   Silero VAD    faster-whisper      Piper / Kokoro
      (~5% 1 core)   (~2ms/frame)  base/small/medium   RTF 0.14 / ~70ms chunk
```

Fuente: guía BigIron (HA Wyoming) + aria-voice + runa voice-pipeline (RPi5). Servicios Wyoming swappable por etapa.

### 3.2 Latencias publicadas (reales, con hardware)

**aria-voice — medido en RX 9060 XT (whisper.cpp/Vulkan + Kokoro/ONNX CPU + oWW/Silero):**

| Etapa | Medido | Presupuesto spec |
|-------|--------|------------------|
| Wake word (por frame 80ms) | ~2 ms | trivial |
| STT (warm, utterance corta) | ~250 ms | 150–400 ms |
| TTS primer chunk | ~70 ms | 150–400 ms |
| **Local first-audio** | **~325 ms** | **< 900 ms** |
| LLM primer token (remoto) | variable | se reporta aparte |

> Regla de oro de aria: el TTFT del LLM remoto domina el e2e — el SLO local (<900ms) se mide y reporta separado.

**faster-whisper (guía BigIron + RPi5 runa-pipeline):**

| Config | Latencia | Notas |
|--------|----------|-------|
| base, CPU-only | ~500ms–1s, 1-2 GB RAM | `vad_filter=True` (Silero integrado) segmenta por silencios |
| small, GPU | ~150 ms, 1-2 GB VRAM | sweet spot conversacional |
| medium, GPU | ~400 ms | mejor WER |
| tiny/base en RPi5 CPU | <1 s | viable embebido |

**whisper.cpp vs faster-whisper** (promptquorum 2026): mismo WER (mismos pesos); whisper.cpp ~15× realtime en i5-13400F (large-v3) vs faster-whisper ~2×; faster-whisper gana en integración Python + VAD turnkey; whisper.cpp sumó VAD nativo (`--vad` + modelo Silero) pero el modo stream exige tunear `--step/--length`.

**Kokoro-82M (ONNX) — números dispersos pero convergentes:**

| Medición | Valor | Condición |
|----------|-------|-----------|
| Frase corta full-utterance, warm | **47 ms** | RTX 4090, no-streaming (dev.to/danivs10) |
| TTFB streaming (1ª oración) | **~50–157 ms** local; ~250-300ms vía CDN | split por oración, modelo warm (kokoro-tts STREAMING_OPTIMIZATION, AWS blog: batch 329ms → bidi 157ms, −52%) |
| Frase 3.3s en CPU desktop | 0.66–0.75 s | Ryzen 9 5950X, 16 threads |
| Cold load / primera síntesis | **14.9 s / 2.44 s** | ¡warmup obligatorio al boot! |
| Costo fijo por call | **~0.51 s/call** | Trocear de más penaliza: 12→22 chunks baja ratio ×0.95→×0.87 (tts-cpu-benchmark). **Conclusión: chunkear por oración (no por cláusula) y pipear.** |
| Modelo | ~310 MiB | vs ~60 MiB por voz Piper |

**Piper TTS:** RTF ~0.14 (voz cori-medium 22kHz, RPi5); agregación throughput +17% con 2 workers single-thread (1 thread/worker/core en CPU chica). Ideal como motor liviano fallback (aria-voice lo mantiene como opción).

**Silero VAD:** despreciable en CPU (~2ms/frame); en faster-whisper corre en CPU a propósito (más rápido que GPU para este tamaño; issue SYSTRAN#1388). Batch `vad_batch_size=16` acelera hasta ×4.3 en CPU de 8 hilos.

### 3.3 Barge-in / turn-taking (LiveKit = spec a copiar)

- **Adaptive interruption**: modelo entrenado en audio conversacional real que distingue *interrupción verdadera* de *backchannel* ("ajá", "mmm") por señal acústica — **no espera al transcript**, responde más rápido y corta menos de más. Requiere Agents SDK Python ≥1.5 / Node ≥1.2.
- **TurnDetector** open-weights multilingüe sobre VAD/STT endpointing + **Silero VAD**.
- Defaults que funcionan: `backchannel_boundary=(1.0, 1.0)` (1s de cooldown al inicio/fin del turno del agente), `false_interruption_timeout=2.0s` (si interrumpe y luego silencio → evento `agent_false_interruption` y **retoma el habla** con `resume_false_interruption=True`).
- Sin VAD plugin, el barge-in cae a interim/final transcripts (peor). Con realtime-LLM + server-side turn detection, el agente delega.
- Mínimo viable sin LiveKit: VAD speech-start durante TTS → `interrupt()` + duck/cancel hooks (ver `bargekit`: eventos `bargekit.barge_in.requested`, `output.cancel_requested`, controlador `createOutputDuckingController`, fixtures sintéticas para tuning).

```ts
// LiveKit Agents (Node) — config de turnos recomendada
const session = new voice.AgentSession({
  // ...stt, llm, tts, vad: silero
  turnHandling: {
    turnDetection: new inference.TurnDetector(),
    endpointing: { minDelay: 500, maxDelay: 3000 },
    interruption: { mode: "adaptive" }, // o { mode: "vad" } sin cloud
  },
});
```

---

## 4) ⭐ Permiso de micrófono en webview Linux (Tauri/WRY/WebKitGTK getUserMedia)

### 4.1 Causa raíz (verificada, no folklore)

1. **WebKitGTK niega por default**: *"When a WebKitUserMediaPermissionRequest is not handled by the user, it is denied by default."* ([docs WebKitGTK 2.38/2.39](https://webkitgtk.org/reference/webkit2gtk/2.39.6/class.UserMediaPermissionRequest.html)). Sin handler del signal `permission-request`, `getUserMedia()` rechaza con `NotAllowedError` aunque el mic del SO ande perfecto.
2. **`enable-media-stream` viene OFF** en el WebView de Tauri → `navigator.mediaDevices` ni siquiera expone un getUserMedia funcional.
3. **Ni wry ni tauri-runtime-wry conectan ese signal**: auditado en [locally-uncensored#162](https://github.com/PurpleDoubleD/locally-uncensored/issues/162) — cero ocurrencias de `permission` en `wry@0.54.4 src/webkitgtk/` y en `tauri-runtime-wry@2.10.3`. No hay env var ni setting que lo salve; **hay que hacerlo en Rust**.
4. No es problema de secure-context: wry ya registra el scheme de la app como seguro (`register_uri_scheme_as_secure`).
5. Comportamiento por SO (idéntico en los 3 proyectos que lo resolvieron):
   - **Linux (WebKitGTK)**: hacerlo a mano (settings + handler). ← esta sección
   - **macOS (WKWebView)**: el `WryWebViewUIDelegate` de wry ya auto-grantea todo `WKMediaCaptureType` — nada que hacer en código (pero el bundle necesita entitlement de mic si `hardenedRuntime`, y el toggle de privacidad del SO manda).
   - **Windows (WebView2)**: suscribirse a `PermissionRequested` y permitir Micrófono/Cámara (wry solo auto-grantea clipboard).

### 4.2 Solución A — shim completo (lemonade, MIT-ish — copiar verbatim)

Fuente: [`lemonade/src/app/src-tauri/src/webview_shim.rs`](https://github.com/lemonade-sdk/lemonade/blob/main/src/app/src-tauri/src/webview_shim.rs) (raw: <https://raw.githubusercontent.com/lemonade-sdk/lemonade/main/src/app/src-tauri/src/webview_shim.rs>). Se llama una vez desde `setup()` con la ventana main.

**`Cargo.toml`** (Linux-only):

```toml
[target.'cfg(target_os = "linux")'.dependencies]
webkit2gtk = "2"
glib = "0.18" # que matchee la versión que pide tu wry; ver Cargo.lock
```

**`src/webview_shim.rs`** (extracto Linux — el archivo real trae también macOS/Windows + user-script interceptor):

```rust
use tauri::WebviewWindow;

/// Llamar una vez desde setup() cuando main ya existe.
pub(crate) fn apply(window: &WebviewWindow) {
    if let Err(err) = window.with_webview(install_platform_shim) {
        log::warn!("Failed to install platform webview shim: {err}");
    }
}

#[cfg(target_os = "linux")]
fn install_platform_shim(webview: tauri::webview::PlatformWebview) {
    use glib::object::{Cast, ObjectExt};
    use webkit2gtk::{
        PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, WebViewExt,
    };

    let wv = webview.inner();

    // 1) Prender media-stream / webrtc / mediasource. OFF por default en Tauri.
    if let Some(settings) = wv.settings() {
        settings.set_enable_media_stream(true);
        settings.set_enable_mediasource(true);
        settings.set_enable_webrtc(true);
    }

    // 2) Auto-grantear mic/cámara. SIN esto, NotAllowedError siempre.
    wv.connect_permission_request(|_wv, request| {
        if request.is::<UserMediaPermissionRequest>() {
            request.allow();
            true
        } else {
            false
        }
    });
}
```

**Windows** (mismo archivo, para completar la matriz):

```rust
#[cfg(target_os = "windows")]
fn install_platform_shim(webview: tauri::webview::PlatformWebview) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::PermissionRequestedEventHandler;

    let controller = webview.controller();
    let Ok(core) = (unsafe { controller.CoreWebView2() }) else { return };
    let mut token = 0i64;
    let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
        let Some(args) = args else { return Ok(()) };
        let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
        unsafe { args.PermissionKind(&mut kind)? };
        if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
            || kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA
        {
            unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)? };
        }
        Ok(())
    }));
    let _ = unsafe { core.add_PermissionRequested(&handler, &mut token) };
}
```

Dependencias Windows: `webview2-com` + `windows` (ver Cargo.toml de lemonade para versiones exactas).

### 4.3 Solución B — deny-by-default con chequeo de origen (buzz — la más segura)

Fuente: [block/buzz `linux_media.rs`](https://github.com/block/buzz/commit/c9aa55505c544c608ff71648bbfd21b235637f19.patch) (fork con raw en `MillionsMx/buzz …/desktop/src-tauri/src/linux_media.rs`). Misma idea, pero solo permite si el request viene del origen propio y pide device real — importante porque Tauri no restringe navegación por default.

```rust
const PROD_ORIGIN: &str = "tauri://localhost";
#[cfg(debug_assertions)]
const DEV_ORIGIN: &str = "http://localhost:1420"; // tu puerto Vite

fn is_trusted_media_origin(uri: &str) -> bool {
    fn matches(uri: &str, origin: &str) -> bool {
        uri == origin
            || uri.strip_prefix(origin)
                .is_some_and(|rest| rest.starts_with('/'))
    }
    if matches(uri, PROD_ORIGIN) { return true; }
    #[cfg(debug_assertions)]
    if matches(uri, DEV_ORIGIN) { return true; }
    false
}

#[cfg(target_os = "linux")]
pub fn enable_media_capture<R: tauri::Runtime>(webview: &tauri::Webview) {
    use webkit2gtk::{
        glib::prelude::Cast, PermissionRequestExt, SettingsExt,
        UserMediaPermissionRequest, UserMediaPermissionRequestExt, WebViewExt,
    };
    let _ = webview.with_webview(|platform_webview| {
        let wv = platform_webview.inner();
        if let Some(settings) = WebViewExt::settings(&wv) {
            settings.set_enable_media_stream(true);
        }
        wv.connect_permission_request(|wv, request| {
            let Some(req) = request.downcast_ref::<UserMediaPermissionRequest>() else {
                return false; // no-UserMedia: default handling
            };
            let uri = wv.uri().map(|u| u.to_string()).unwrap_or_default();
            let for_device = req.is_for_audio_device() || req.is_for_video_device();
            if for_device && is_trusted_media_origin(&uri) {
                req.allow();
            } else {
                req.deny();
            }
            true // consumir el signal para que no corra el auto-deny
        });
    });
}
```

**Pin de versión crítico** (del commit de buzz): fijar `webkit2gtk` a la versión exacta que linkea tu wry para no duplicar `webkit2gtk-sys`:

```toml
# Cargo.toml — bump en lockstep con wry
webkit2gtk = { version = "=2.0.2", features = ["v2_22"] }
```

Llamar desde `on_webview_ready` / `setup` para **cada webview que use mic** (VoiceStudio aprendió por las malas: pill/widget es un WebView separado con su propio permission handling — iterar `["main", "widget"]`).

```rust
// tauri.conf.json NO alcanza — va en Rust, en setup():
for label in ["main", "widget"] {
    if let Some(win) = app.get_webview_window(label) {
        linux_media::enable_media_capture(&win); // no-op fuera de Linux
    }
}
```

### 4.4 Solución C — bypassear el webview (grabar en backend)

Varios proyectos (sugerencia preferida en locally-uncensored#162, arquitectura lyns-voice a medias) graban **fuera del webview**: el motor de voz ya habla con PipeWire/ALSA, se saltea el permission layer y el echo-cancellation del webview.

- En Tauri: comando Rust con `cpal` → stream PCM → `emit` chunks al frontend o directo al STT.
- Costo: más código, selector de dispositivo propio, VAD propio. Beneficio: cero dependencia de WebKit, funciona idéntico en las 3 plataformas, y el wake-word always-on no necesita webview vivo.
- Híbrido pragmático (recomendado §5): **webview getUserMedia + shim (A/B) para PTT/conversación**, backend `cpal` solo si el wake-word always-on lo pide.

### 4.5 Checklist de verificación

1. `navigator.mediaDevices.getUserMedia({audio:true})` resuelve en la app empaquetada (.deb/AppImage), no solo en `tauri dev`.
2. En Wayland probar con `WEBKIT_DISABLE_DMABUF_RENDERER=1` si hay glitches de render (no afecta mic, pero es el otro clásico de WebKitGTK).
3. Consola web sin `NotAllowedError`; `about:blank`/iframes externos siguen denegados (solución B).
4. Probar con **segunda ventana/widget**: cada WebView necesita su propio handler.

Threads raíz: [tauri#8346](https://github.com/tauri-apps/tauri/issues/8346) (cerrado "wontfix" en 2023 — el shim manual es el camino oficial de facto), [discusión tauri#8426](https://github.com/orgs/tauri-apps/discussions/8426) (WebRTC funcional en WebKitGTK), [wry#85](https://github.com/tauri-apps/wry/issues/85) (locked).

---

## 5) Top 5 recomendaciones (Tauri 2 + frontend web + sidecar Node)

1. **Mic en Linux = shim Rust deny-by-default (buzz §4.3), NO pelear con configs.**
   Copiar `linux_media.rs` verbatim, pinear `webkit2gtk = "=x.y.z"` al wry del lockfile, llamar para cada ventana (`main` + overlay/widget) desde `setup()`. Captura inicial en el **frontend vía getUserMedia** (cero código nativo extra, funciona en Win/Mac day-one); si más tarde el wake-word always-on pide mic sin webview, agregar captura `cpal` en Rust como comando Tauri con stream de PCM — no en Node (módulos nativos de mic en Node son frágiles; el sidecar Node queda para orquestación/LLM, no para audio de bajo nivel).

2. **Pipeline default: Silero VAD → faster-whisper `small` (GPU) / `base` (CPU) → Kokoro sentence-streaming, todo warm en boot.**
   Presupuesto local medido por aria-voice: STT ~250ms + TTS primer chunk ~70ms = **first-audio ~325ms, SLO <900ms**, LLM aparte. Warmup obligatorio (Kokoro frío: 14.9s load + 2.44s primera síntesis). Chunkear TTS **por oración** (costo fijo ~0.51s/call — trocear por cláusula destruye throughput). Piper como fallback liviano (60 MiB/voz, RTF 0.14). Empaquetar como sidecars con health-check + `smoke:e2e` con latency report (aria-voice) para que cada cambio de modelo/prese muestre números, no sensaciones.

3. **UX: orbe 4-estados + atajo global + PiP 180×180 + Esc barge-in (lyns-voice + tauri-overlay-demo).**
   `deriveState()` con prioridad speaking>listening>thinking>idle; overlay `transparent/decorations:false/alwaysOnTop/skipTaskbar`; global shortcut (default sugerido `Ctrl+Alt+Espacio` o `Super+.` — verificar colisiones GNOME/KDE) que muestra/enfoca; registro fallido = log + seguir (tray cubre); `CloseRequested→hide`; modo PiP mini orbe; Esc interrumpe turno; Space togglea mic (suprimido en inputs). Mic osciloscopio siempre visible = "me escucha" sin adivinar.

4. **Turn-taking: VAD-gating day-one, adaptive barge-in en fase 2 (LiveKit spec).**
   Día 1: `webrtc-vad`/Silero endpointing (auto-send en pausa ~500-800ms) + barge-in por speech-durante-TTS con duck/cancel + `false_interruption_timeout≈2s` con resume (copiar semántica LiveKit aunque la implementación sea propia o `bargekit`). Fase 2: `TurnDetector` open-weights + modo adaptive para no cortar backchannels. Wake word (openWakeWord, ~5% core, opt-in explícito) solo después de que PTT + auto-send estén sólidos — orden: **PTT → auto-send → barge-in → wake**.

5. **Reglas de robustez que todos aprendieron a golpes:**
   - Descarga de modelos **resumable con progreso+ETA** en first-run, nunca en el path crítico (lyns-voice, Jan).
   - TTS/STT en **workers/sidecars desacoplados**: la sesión de chat nunca espera a síntesis (hook detached de claude-voice-mode; daemon Kokoro por socket).
   - Persistir transcript + config (`~/.config/<app>/`), retención 7 días, y **redactar spans sensibles antes de escribir memoria** (isair/jarvis).
   - CI: overlay demo testeable sin backend (`pnpm mock`/WebSocket mock + `no server` indicator) para que el frontend nunca dependa de dos terminales (tauri-overlay-demo).

---

### Fuentes principales (links directos)

- Shim mic Linux: lemonade `webview_shim.rs` (raw) · buzz `linux_media.rs` patch · VoiceStudio `lib.rs` (pill/widget) · tauri#8346 · disc. tauri#8426 · locally-uncensored#162 (auditoría wry/tauri-runtime-wry) · WebKitGTK `UserMediaPermissionRequest`
- Voz/UX: lyns-voice · openinterpreter/01 (+docs) · isair/jarvis (+review hysenlabs) · mbailey/voicemode · tauri-overlay-demo · Hermes wake-word docs
- Audio/latencias: aria-voice (tabla medido) · BigIron pipeline guide · runa/voice-pipeline (RPi5) · promptquorum whisper bench · tts-cpu-benchmark · kokoro STREAMING_OPTIMIZATION · AWS Kokoro bidi · SYSTRAN faster-whisper#1388 (VAD en CPU)
- Turn-taking: LiveKit adaptive-interruption + turn-detection + TurnHandlingOptions · bargekit
