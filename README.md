# Pi Desktop

Thin Tauri shell over the `pi` coding agent. Pi owns the agent, sessions,
skills, and models — this app is just a hotkey popup + sessions window.

No Electron: Tauri 2 + system WebView. Frontend is vanilla TS + highlight.js.

## Install (Arch/CachyOS)

Prerequisites: the [`pi` CLI](https://pi.dev) on PATH, Node.js 22+, Rust,
and WebKitGTK system libs:

```bash
sudo pacman -S --needed webkit2gtk-4.1 base-devel nodejs npm
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
```

Build + install:

```bash
git clone git@github.com:Sheerabth/pi-desktop.git ~/Projects/pi-desktop
cd ~/Projects/pi-desktop
npm install
export PATH="$HOME/.cargo/bin:$PATH"
npm run build && npx tauri build --bundles deb
cp -f src-tauri/target/release/pi-desktop ~/.local/bin/pi-desktop-bin
printf '#!/bin/sh\nexec env WEBKIT_DISABLE_DMABUF_RENDERER=1 "$HOME/.local/bin/pi-desktop-bin" "$@"\n' > ~/.local/bin/pi-desktop
chmod +x ~/.local/bin/pi-desktop
```

Then add the launcher entry (`~/.local/share/applications/pi-desktop.desktop`
pointing at `~/.local/bin/pi-desktop`) and the KDE shortcuts below.

> NVIDIA + Wayland: `WEBKIT_DISABLE_DMABUF_RENDERER=1` works around an
> upstream WebKitGTK/KWin explicit-sync protocol kill (Tauri issue #10702).
> Drop it once either side fixes it.

## Develop

```bash
cd ~/Projects/pi-desktop
export PATH="$HOME/.cargo/bin:$PATH"
WEBKIT_DISABLE_DMABUF_RENDERER=1 npx tauri dev
```

Frontend hot-reloads on save. Release installs come from `tauri build`.

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
