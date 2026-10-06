// pi-quickbar backend: thin Tauri shell over `pi --mode rpc`.
// First principles: pi owns agent/sessions/skills/models. This app only
// spawns one pi RPC child per working dir, forwards JSONL, lists session
// files, and toggles windows via hotkeys.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_global_shortcut::ShortcutState;

// ---------------------------------------------------------------- config

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct AppConfig {
    quickbar_hotkey: String,
    main_hotkey: String,
    default_dir: String,
    recents: Vec<String>,
    last_cwd: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        let home = dirs::home_dir().unwrap_or(PathBuf::from("/tmp"));
        let qa = home.join(".pi-qa");
        Self {
            // Both editable in Settings. (Ctrl+Shift+Space was already grabbed
            // on this machine, so Super-based defaults that KDE leaves free.)
            quickbar_hotkey: "Super+J".into(),
            main_hotkey: "Super+Shift+J".into(),
            default_dir: qa.to_string_lossy().into_owned(),
            recents: vec![],
            last_cwd: qa.to_string_lossy().into_owned(),
        }
    }
}

fn config_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or(PathBuf::from("/tmp"));
    base.join("pi-quickbar").join("config.json")
}

fn load_config() -> AppConfig {
    let p = config_path();
    if let Ok(raw) = fs::read_to_string(&p) {
        if let Ok(c) = serde_json::from_str::<AppConfig>(&raw) {
            return c;
        }
    }
    AppConfig::default()
}

fn save_config(c: &AppConfig) {
    let p = config_path();
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(raw) = serde_json::to_string_pretty(c) {
        let _ = fs::write(p, raw);
    }
}

// ---------------------------------------------------------------- pi procs

struct PiProc {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
}

struct AppState {
    procs: Mutex<HashMap<String, PiProc>>,
    config: Mutex<AppConfig>,
}

fn session_root_default() -> String {
    if let Ok(v) = std::env::var("PI_CODING_AGENT_SESSION_DIR") {
        if !v.is_empty() {
            return v;
        }
    }
    let home = dirs::home_dir().unwrap_or(PathBuf::from("/tmp"));
    home.join(".pi")
        .join("agent")
        .join("sessions")
        .to_string_lossy()
        .into_owned()
}

// Launched from a terminal, `pi` is on PATH. Launched from the KDE
// launcher it is NOT (~/.pi/agent/bin is shell-only). So resolve it:
// explicit PI_BIN first, then well-known locations, then PATH lookup.
fn pi_bin() -> String {
    if let Ok(v) = std::env::var("PI_BIN") {
        if !v.is_empty() {
            return v;
        }
    }
    if let Some(home) = dirs::home_dir() {
        for sub in [".pi/agent/bin/pi", ".local/bin/pi"] {
            let p = home.join(sub);
            if p.is_file() {
                return p.to_string_lossy().into_owned();
            }
        }
    }
    "pi".to_string()
}

fn proc_alive(p: &PiProc) -> bool {
    p.child
        .lock()
        .map(|mut c| matches!(c.try_wait(), Ok(None)))
        .unwrap_or(false)
}

/// Spawn (or reuse) a `pi --mode rpc` child rooted at `cwd`.
fn proc_key(tag: &Option<String>, cwd: &str) -> String {
    format!("{}\n{}", tag.clone().unwrap_or_else(|| "main".to_string()), cwd)
}

#[tauri::command]
fn pi_ensure(cwd: String, session_dir: Option<String>, tag: Option<String>, app: AppHandle, state: State<AppState>) -> Result<String, String> {
    let key = proc_key(&tag, &cwd);
    {
        let procs = state.procs.lock().map_err(|e| e.to_string())?;
        if let Some(p) = procs.get(&key) {
            if proc_alive(p) {
                return Ok("running".into());
            }
        }
    }
    // Reap dead proc if present.
    {
        let mut procs = state.procs.lock().map_err(|e| e.to_string())?;
        procs.remove(&key);
    }

    // Make sure the dir exists (default Q&A dir may not yet).
    let _ = fs::create_dir_all(&cwd);

    let mut cmd = Command::new(pi_bin());
    cmd.arg("--mode")
        .arg("rpc")
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(sd) = session_dir {
        if !sd.is_empty() {
            cmd.arg("--session-dir").arg(sd);
        }
    }
    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn pi: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;

    // Forward every stdout JSONL record to the frontend with its cwd.
    let app2 = app.clone();
    let cwd2 = cwd.clone();
    let tag2 = tag.clone().unwrap_or_else(|| "main".to_string());
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if line.trim().is_empty() {
                continue;
            }
            let record: serde_json::Value =
                serde_json::from_str(&line).unwrap_or(serde_json::Value::String(line));
            let _ = app2.emit(
                "pi-record",
                serde_json::json!({ "cwd": cwd2, "tag": tag2, "record": record }),
            );
        }
    });

    let mut procs = state.procs.lock().map_err(|e| e.to_string())?;
    procs.insert(
        key,
        PiProc {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
        },
    );
    // Remember as last used. Quickbar dirs stay out of the shared recents:
    // its throwaway Q&A dirs would drown the real project list.
    if tag.as_deref() != Some("quickbar") {
        let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.last_cwd = cwd.clone();
        cfg.recents = push_recent(cfg.recents.clone(), &cwd);
        let snapshot = cfg.clone();
        save_config(&snapshot);
    }
    Ok("started".into())
}

fn push_recent(mut recents: Vec<String>, cwd: &str) -> Vec<String> {
    recents.retain(|d| d != cwd);
    recents.insert(0, cwd.to_string());
    recents.truncate(12);
    recents
}

/// Write one JSON command line to the pi child for `cwd`.
#[tauri::command]
fn pi_send(cwd: String, payload: serde_json::Value, tag: Option<String>, state: State<AppState>) -> Result<(), String> {
    let procs = state.procs.lock().map_err(|e| e.to_string())?;
    let p = procs.get(&proc_key(&tag, &cwd)).ok_or("no pi running for this dir (call pi_ensure)")?;
    if !proc_alive(p) {
        return Err("pi exited (call pi_ensure)".into());
    }
    let mut line = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    line.push('\n');
    p.stdin
        .lock()
        .map_err(|e| e.to_string())?
        .write_all(line.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn pi_stop(cwd: String, tag: Option<String>, state: State<AppState>) -> Result<(), String> {
    let mut procs = state.procs.lock().map_err(|e| e.to_string())?;
    if let Some(p) = procs.remove(&proc_key(&tag, &cwd)) {
        if let Ok(mut c) = p.child.lock() {
            let _ = c.kill();
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- sessions

#[derive(Debug, Clone, serde::Serialize)]
struct SessionInfo {
    path: String,
    id: String,
    timestamp: String,
    cwd: String,
    name: Option<String>,
    preview: Option<String>,
}

/// Best-effort quoted string value for `key` inside `obj` (flat scan, KISS).
fn quoted_after(obj: &str, key: &str) -> Option<String> {
    let n = obj.find(key)?;
    let seg = &obj[n + key.len()..];
    let c = seg.find(':')?;
    let v = seg[c + 1..].trim_start().strip_prefix('"')?;
    let mut s = String::new();
    let mut chars = v.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(e) = chars.next() {
                s.push(e);
            }
        } else if ch == '"' {
            break;
        } else {
            s.push(ch);
        }
        if s.len() > 160 {
            break;
        }
    }
    let s = s.trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// Display name from `session_info` entries (set via /name). Last one wins.
fn scan_name(blob: &str) -> Option<String> {
    let mut name: Option<String> = None;
    let mut rest = blob;
    while let Some(i) = rest.find("\"type\":\"session_info\"") {
        let seg = &rest[i..(i + 600).min(rest.len())];
        if let Some(n) = quoted_after(seg, "\"name\"") {
            name = Some(n);
        }
        rest = &rest[i + 1..];
    }
    name
}

/// First user message text, for sidebar preview. Skips bash-echo noise.
fn scan_preview(blob: &str) -> Option<String> {
    let mut rest = blob;
    while let Some(i) = rest.find("\"role\":\"user\"") {
        let seg = &rest[i..(i + 2000).min(rest.len())];
        if let Some(t) = quoted_after(seg, "\"text\"") {
            if !t.starts_with("Ran `") {
                return Some(t);
            }
        }
        rest = &rest[i + 1..];
    }
    None
}

/// List session files (newest first), optionally filtered to one cwd.
/// Reads only the header line + a small tail per file. KISS: no index DB.
#[tauri::command]
fn list_sessions(cwd_filter: Option<String>, session_root: Option<String>) -> Result<Vec<SessionInfo>, String> {
    let root = session_root.unwrap_or_else(session_root_default);
    let mut out: Vec<SessionInfo> = vec![];
    let groups = fs::read_dir(&root).map_err(|e| format!("session dir unreadable ({root}): {e}"))?;
    for g in groups.flatten() {
        let gp = g.path();
        if !gp.is_dir() {
            continue;
        }
        let files = match fs::read_dir(&gp) {
            Ok(f) => f,
            Err(_) => continue,
        };
        for f in files.flatten() {
            let p = f.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let content = match fs::read_to_string(&p) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let head_end = content.find('\n').unwrap_or(content.len().min(2000));
            let head: serde_json::Value = match serde_json::from_str(&content[..head_end]) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let cwd = head.get("cwd").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if let Some(ref want) = cwd_filter {
                if !want.is_empty() && &cwd != want {
                    continue;
                }
            }
            let id = head.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let timestamp = head.get("timestamp").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let tail_start = content.len().saturating_sub(16384);
            let name = scan_name(&content[tail_start..]);
            // Preview: first user text (cap scan at 256KB for huge files).
            let preview = scan_preview(&content[..content.len().min(262144)]);
            let _ = head_end;
            out.push(SessionInfo {
                path: p.to_string_lossy().into_owned(),
                id,
                timestamp,
                cwd,
                name,
                preview,
            });
        }
    }
    out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(out)
}

#[tauri::command]
fn delete_session(path: String, session_root: Option<String>) -> Result<(), String> {
    let root = session_root.unwrap_or_else(session_root_default);
    let p = PathBuf::from(&path);
    if !p.starts_with(&root) {
        return Err("refusing to delete outside session dir".into());
    }
    fs::remove_file(&p).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- config

#[tauri::command]
fn get_config(state: State<AppState>) -> AppConfig {
    state.config.lock().map(|c| c.clone()).unwrap_or_default()
}

#[tauri::command]
fn set_config(patch: serde_json::Value, app: AppHandle, state: State<AppState>) -> Result<AppConfig, String> {
    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
    if let Some(v) = patch.get("default_dir").and_then(|v| v.as_str()) {
        cfg.default_dir = v.to_string();
    }
    if let Some(v) = patch.get("last_cwd").and_then(|v| v.as_str()) {
        cfg.last_cwd = v.to_string();
    }
    if let Some(arr) = patch.get("recents").and_then(|v| v.as_array()) {
        cfg.recents = arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect();
    }
    if patch.get("quickbar_hotkey").or(patch.get("main_hotkey")).is_some() {
        let q = patch
            .get("quickbar_hotkey")
            .and_then(|v| v.as_str())
            .unwrap_or(&cfg.quickbar_hotkey)
            .to_string();
        let m = patch
            .get("main_hotkey")
            .and_then(|v| v.as_str())
            .unwrap_or(&cfg.main_hotkey)
            .to_string();
        // Validate BEFORE unregister_all: a typo must not wipe working keys.
        let _: tauri_plugin_global_shortcut::Shortcut =
            q.parse().map_err(|_| format!("bad hotkey: {q}"))?;
        let _: tauri_plugin_global_shortcut::Shortcut =
            m.parse().map_err(|_| format!("bad hotkey: {m}"))?;
        cfg.quickbar_hotkey = q;
        cfg.main_hotkey = m;
        let snapshot = cfg.clone();
        drop(cfg);
        apply_hotkeys(&app, &state, &snapshot)?;
        let cfg2 = state.config.lock().map_err(|e| e.to_string())?;
        let snapshot2 = cfg2.clone();
        save_config(&snapshot2);
        return Ok(snapshot2);
    }
    let snapshot = cfg.clone();
    save_config(&snapshot);
    Ok(snapshot)
}

fn apply_hotkeys(app: &AppHandle, _state: &State<AppState>, cfg: &AppConfig) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let _ = app.global_shortcut().unregister_all();
    for (key, win) in [(&cfg.quickbar_hotkey, "quickbar"), (&cfg.main_hotkey, "main")] {
        let shortcut: tauri_plugin_global_shortcut::Shortcut =
            key.parse().map_err(|_| format!("bad hotkey: {key}"))?;
        let app_h = app.clone();
        app.global_shortcut()
            .on_shortcut(shortcut.clone(), move |_app, _s, ev| {
                if ev.state == ShortcutState::Pressed {
                    toggle_window(&app_h, win);
                }
            })
            .map_err(|e| e.to_string())?;
        app.global_shortcut().register(shortcut).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------- windows

fn toggle_window(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            if label == "quickbar" {
                let _ = app.emit("quickbar-hidden", ());
            }
        } else {
            let _ = w.show();
            let _ = w.set_focus();
            if label == "quickbar" {
                let _ = w.center();
                let _ = app.emit("quickbar-shown", ());
            }
        }
    }
}

#[tauri::command]
fn toggle_quickbar(app: AppHandle) {
    toggle_window(&app, "quickbar");
}
#[tauri::command]
fn toggle_main(app: AppHandle) {
    toggle_window(&app, "main");
}
#[tauri::command]
fn show_window(app: AppHandle, label: String) {
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}
#[tauri::command]
fn hide_window(app: AppHandle, label: String) {
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.hide();
    }
}

/// Bring up the full sessions window for a cwd (used by quickbar's "Open").
#[tauri::command]
fn open_in_main(app: AppHandle, cwd: String, session_path: Option<String>, state: State<AppState>) -> Result<(), String> {
    pi_ensure(cwd.clone(), None, None, app.clone(), state)?;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit(
            "open-request",
            serde_json::json!({ "cwd": cwd, "sessionPath": session_path }),
        );
    }
    Ok(())
}

#[tauri::command]
async fn pick_dir(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .set_title("Choose working directory")
        .blocking_pick_folder();
    Ok(picked.map(|p| p.to_string()))
}

// ---------------------------------------------------------------- run

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cfg = load_config();
    // Ensure default Q&A dir exists so first run just works.
    let _ = fs::create_dir_all(&cfg.default_dir);
    if cfg.last_cwd.is_empty() {
        let mut c = cfg.clone();
        c.last_cwd = c.default_dir.clone();
        save_config(&c);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // KDE-fallback shortcut path: `pi-quickbar --toggle-quickbar`.
            if argv.iter().any(|a| a == "--toggle-quickbar") {
                toggle_window(&app, "quickbar");
            } else if argv.iter().any(|a| a == "--toggle-main" || a == "--toggle-sessions") {
                toggle_window(&app, "main");
            } else if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            procs: Mutex::new(HashMap::new()),
            config: Mutex::new(cfg.clone()),
        })
        .setup(move |app| {
            // First-launch flags (also used by the KDE custom shortcut).
            let args: Vec<String> = std::env::args().collect();
            if args.iter().any(|a| a == "--toggle-quickbar" || a == "--show-quickbar") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
                if let Some(w) = app.get_webview_window("quickbar") {
                    let _ = w.show();
                    let _ = w.set_focus();
                    let _ = w.center();
                }
            }
            if let Err(e) = apply_hotkeys(&app.handle(), &app.state::<AppState>(), &cfg) {
                eprintln!("hotkey registration failed: {e} (edit in Settings; KDE shortcut still works)");
            }
            Ok(())
        })
        .on_window_event(|win, ev| {
            // Hidden quickbar window keeps the process alive, so closing the
            // sessions window must quit explicitly. Otherwise relaunches keep
            // showing the stale version (single-instance forwards to us).
            if win.label() == "main" {
                if let WindowEvent::CloseRequested { .. } = ev {
                    win.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            pi_ensure,
            pi_send,
            pi_stop,
            list_sessions,
            delete_session,
            get_config,
            set_config,
            toggle_quickbar,
            toggle_main,
            show_window,
            hide_window,
            open_in_main,
            pick_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
