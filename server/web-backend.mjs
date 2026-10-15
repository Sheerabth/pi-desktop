// Dev-only web backend for pi-desktop browser mode (`npm run dev:web`).
// Mirrors src-tauri/src/lib.rs: same commands, same pi-proc management, same
// session scanning — so the frontend can't tell Tauri IPC from fetch/SSE.
// window-only commands (toggles, tray) are harmless no-ops here.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, ChildProcess } from "node:child_process";

const PORT = Number(process.env.PORT || 1421);
const HOME = os.homedir();

// ---------------------------------------------------------------- config

function defaultConfig() {
  const qa = path.join(HOME, ".pi-qa");
  return {
    quickbar_hotkey: "Super+J",
    main_hotkey: "Super+Shift+J",
    default_dir: qa,
    recents: [],
    last_cwd: qa,
    run_in_bg: true,
  };
}

function configPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(HOME, ".config");
  return path.join(base, "pi-quickbar", "config.json");
}

function loadConfig() {
  try {
    return { ...defaultConfig(), ...JSON.parse(fs.readFileSync(configPath(), "utf8")) };
  } catch {
    return defaultConfig();
  }
}

function saveConfig(c) {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(c, null, 2));
  } catch {}
}

let CONFIG = loadConfig();

// ---------------------------------------------------------------- pi procs

function sessionRootDefault() {
  if (process.env.PI_CODING_AGENT_SESSION_DIR) return process.env.PI_CODING_AGENT_SESSION_DIR;
  return path.join(HOME, ".pi", "agent", "sessions");
}

function piBin() {
  if (process.env.PI_BIN) return process.env.PI_BIN;
  for (const sub of [".pi/agent/bin/pi", ".local/bin/pi"]) {
    const p = path.join(HOME, sub);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return "pi";
}

// key: `${tag}\n${key}` -> { child, alive }
const procs = new Map();
const sseClients = new Set();

function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(line);
    } catch {}
  }
}

function pushRecent(recents, cwd) {
  const out = [cwd, ...recents.filter((d) => d !== cwd)];
  return out.slice(0, 12);
}

function ensureProc({ cwd, sessionDir, tag, key, sessionPath }) {
  const pkey = `${tag || "main"}\n${key}`;
  const existing = procs.get(pkey);
  if (existing && existing.alive) return "running";
  if (existing) {
    try {
      existing.child.kill();
    } catch {}
    procs.delete(pkey);
  }
  fs.mkdirSync(cwd, { recursive: true });
  // Same media primer as the Tauri backend (see src/media-primer.md):
  // capability + agent knowledge ship together, no skill install step.
  let primer = null;
  try {
    primer = fs.readFileSync(new URL("../src/media-primer.md", import.meta.url), "utf8");
  } catch {}
  const args = ["--mode", "rpc"];
  if (primer) args.push("--append-system-prompt", primer);
  if (sessionDir) args.push("--session-dir", sessionDir);
  if (sessionPath) args.push("--session", sessionPath);
  const child = spawn(piBin(), args, { cwd, stdio: ["pipe", "pipe", "ignore"] });
  const entry = { child, alive: true };
  child.on("exit", () => (entry.alive = false));
  child.on("error", () => (entry.alive = false));
  // forward stdout JSONL as pi-record events
  let buf = "";
  const tagName = tag || "main";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        record = line;
      }
      broadcast({ cwd, tag: tagName, key, record });
    }
  });
  procs.set(pkey, entry);
  if (tag !== "quickbar") {
    CONFIG.last_cwd = cwd;
    CONFIG.recents = pushRecent(CONFIG.recents, cwd);
    saveConfig(CONFIG);
  }
  return "started";
}

function sendProc({ payload, tag, key }) {
  const pkey = `${tag || "main"}\n${key}`;
  const p = procs.get(pkey);
  if (!p) throw new Error("no pi running for this session (call pi_ensure)");
  if (!p.alive) throw new Error("pi exited (call pi_ensure)");
  p.child.stdin.write(JSON.stringify(payload) + "\n");
}

function stopProc({ tag, key }) {
  const pkey = `${tag || "main"}\n${key}`;
  const p = procs.get(pkey);
  if (p) {
    try {
      p.child.kill();
    } catch {}
    procs.delete(pkey);
  }
}

// ---------------------------------------------------------------- sessions

function quotedAfter(obj, key) {
  const n = obj.indexOf(key);
  if (n < 0) return null;
  const seg = obj.slice(n + key.length);
  const c = seg.indexOf(":");
  if (c < 0) return null;
  let v = seg.slice(c + 1).trimStart();
  if (!v.startsWith('"')) return null;
  v = v.slice(1);
  let s = "";
  for (let i = 0; i < v.length && s.length <= 160; i++) {
    const ch = v[i];
    if (ch === "\\" && i + 1 < v.length) {
      s += v[++i];
    } else if (ch === '"') {
      break;
    } else {
      s += ch;
    }
  }
  s = s.trim();
  return s || null;
}

function scanName(blob) {
  let name = null;
  let rest = blob;
  for (;;) {
    const i = rest.indexOf('"type":"session_info"');
    if (i < 0) break;
    const seg = rest.slice(i, i + 600);
    const n = quotedAfter(seg, '"name"');
    if (n) name = n;
    rest = rest.slice(i + 1);
  }
  return name;
}

function scanPreview(blob) {
  let rest = blob;
  for (;;) {
    const i = rest.indexOf('"role":"user"');
    if (i < 0) break;
    const seg = rest.slice(i, i + 2000);
    const t = quotedAfter(seg, '"text"');
    if (t && !t.startsWith("Ran `")) return t;
    rest = rest.slice(i + 1);
  }
  return null;
}

function listSessions(cwdFilter, sessionRoot) {
  const root = sessionRoot || sessionRootDefault();
  const out = [];
  let groups;
  try {
    groups = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    throw new Error(`session dir unreadable (${root}): ${e.message}`);
  }
  for (const g of groups) {
    if (!g.isDirectory()) continue;
    const gp = path.join(root, g.name);
    let files;
    try {
      files = fs.readdirSync(gp);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const p = path.join(gp, f);
      let content;
      try {
        content = fs.readFileSync(p, "utf8");
      } catch {
        continue;
      }
      const nl = content.indexOf("\n");
      let head;
      try {
        head = JSON.parse(content.slice(0, nl < 0 ? Math.min(content.length, 2000) : nl));
      } catch {
        continue;
      }
      const cwd = head.cwd || "";
      if (cwdFilter && cwd !== cwdFilter) continue;
      const tail = content.slice(Math.max(0, content.length - 16384));
      out.push({
        path: p,
        id: head.id || "",
        timestamp: head.timestamp || "",
        cwd,
        name: scanName(tail),
        preview: scanPreview(content.slice(0, Math.min(content.length, 262144))),
      });
    }
  }
  out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return out;
}

// ---------------------------------------------------------------- commands

const MEDIA_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
  svg: "image/svg+xml", ico: "image/x-icon", avif: "image/avif",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm",
  mov: "video/quicktime", ogv: "video/ogg",
};

function readMedia(mediaPath, base) {
  let p = mediaPath;
  if (p.startsWith("~/")) p = path.join(HOME, p.slice(2));
  else if (p.startsWith("file://")) p = decodeURI(p.replace(/^file:\/\//, ""));
  else if (!path.isAbsolute(p)) {
    if (!base) throw new Error("relative media path with no base dir");
    p = path.join(base, p);
  }
  const st = fs.statSync(p);
  if (st.size > 12 * 1024 * 1024) throw new Error("media file too large for inline display (>12MB)");
  const ext = (path.extname(p).slice(1) || "").toLowerCase();
  const mime = MEDIA_MIME[ext];
  if (!mime) throw new Error(`unsupported media type: .${ext}`);
  return { mime, base64: fs.readFileSync(p).toString("base64") };
}

const handlers = {
  read_media: (p) => readMedia(p.path, p.base ?? null),
  pi_ensure: (p) => ensureProc(p),
  pi_send: (p) => (sendProc(p), null),
  pi_stop: (p) => (stopProc(p), null),
  list_sessions: (p) => listSessions(p.cwdFilter ?? null, p.sessionRoot ?? null),
  delete_session: (p) => {
    const root = p.sessionRoot || sessionRootDefault();
    const resolved = path.resolve(p.path);
    if (!resolved.startsWith(root)) throw new Error("refusing to delete outside session dir");
    fs.unlinkSync(resolved);
    return null;
  },
  get_config: () => CONFIG,
  set_config: (p) => {
    const patch = p.patch || {};
    for (const k of ["default_dir", "last_cwd", "recents", "run_in_bg", "quickbar_hotkey", "main_hotkey"]) {
      if (patch[k] !== undefined) CONFIG[k] = patch[k];
    }
    saveConfig(CONFIG);
    return CONFIG;
  },
  // window-only: no-ops in browser mode
  toggle_quickbar: () => null,
  toggle_main: () => null,
  show_window: () => null,
  hide_window: () => null,
  open_in_main: () => null,
  pick_dir: () => null,
};

function readBody(req) {
  return new Promise((res, rej) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      try {
        res(JSON.parse(s || "{}"));
      } catch (e) {
        rej(e);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/events" || url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }
  if (req.method === "POST" && (url.pathname === "/api/invoke" || url.pathname === "/invoke")) {
    try {
      const { cmd, params } = await readBody(req);
      const fn = handlers[cmd];
      if (!fn) throw new Error(`unknown command: ${cmd}`);
      const data = await fn(params || {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data }));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
    }
    return;
  }
  res.writeHead(404);
  res.end("pi-desktop web backend. POST /api/invoke, GET /api/events");
});

server.listen(PORT, () => console.log(`[web-backend] listening on http://localhost:${PORT}`));

process.on("SIGTERM", () => {
  for (const [, p] of procs) {
    try {
      p.child.kill();
    } catch {}
  }
  process.exit(0);
});
