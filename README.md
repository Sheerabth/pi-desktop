# pi-quickbar

Thin Tauri shell over the `pi` coding agent. Pi owns the agent, sessions,
skills, and models — this app is just a hotkey popup + sessions window.

No Electron: Tauri 2 + system WebView. Frontend is dependency-free vanilla TS.

## Run

Requires `pi` on `PATH` (override with `PI_BIN=/path/to/pi`).

```bash
cd ~/Projects/pi-quickbar
npm run tauri dev
```

Or install the `.deb` from `src-tauri/target/release/bundle/deb/`.

## Hotkeys (both configurable in ⚙ settings)

- Quick bar: `Super+J` (popup: ask, stream, copy, open in sessions)
- Sessions: `Super+Shift+J` (full window: sidebar, per-session working dir, model + thinking pickers)

## Wayland / KDE fallback (recommended)

In-app global hotkeys can fail on Wayland when another app is focused.
Add a native KDE shortcut instead — it works everywhere:

1. `System Settings → Shortcuts → Custom Shortcuts → Add Command`
2. Quick bar: command `pi-desktop --toggle-quickbar`, trigger `Meta+J`
3. Sessions: command `pi-desktop --toggle-main`, trigger `Meta+Shift+J`

(Use different triggers if you change the in-app hotkeys — keep them in sync.)

Single-instance is enforced: the flags toggle the running app, never a second copy.

Autostart: `System Settings → Autostart → Add` the installed binary (no flags;
windows stay hidden until a hotkey, unless `--toggle-quickbar` is passed).

## Scope (v1, locked)

1. Both hotkeys, configurable — 2. Claude-style quick bar (stream + copy + open in sessions)
3. Per-session working dir (recent dirs + `~/.pi-qa` default for one-offs)
4. In-app model + thinking-level pickers (via pi RPC)
5. No search UI — pi + your `agent-search` skill decide (unchanged from terminal)
6. Markdown + code-copy rendering

## How it works

- Backend (`src-tauri/src/lib.rs`): one `pi --mode rpc` child per working dir,
  JSONL forwarded as `pi-record` events; session sidebar scans pi's own
  `~/.pi/agent/sessions` files (cwd in header, name in `session_info`).
- No index DB, no reimplementation: new/resume/switch/fork state all live in pi.

## Layout

- `src/main.ts` + `index.html` — sessions window
- `src/quickbar.ts` + `quickbar.html` — popup
- `src/pi.ts` — id-correlated RPC client
- `src/md.ts` — tiny markdown renderer
