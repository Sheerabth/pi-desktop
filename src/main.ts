// Sessions window: sidebar (dir + sessions), chat, model/thinking pickers,
// settings (hotkeys). Thin view over pi RPC — pi owns everything.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { awaitSession, config, ensure, onRecord, pi, sessions, setKey, setTag, stopChild, type SessionInfo } from "./pi";

// Shown in Settings so installed-vs-running is checkable. Value comes
// from package.json via vite define (single source, see vite.config.ts).
import { renderMd, wireCopy } from "./md";

let cwd = "";
let liveRun: HTMLElement | null = null;
let pendingUser = "";
let liveThinkDiv: HTMLElement | null = null;
let liveThinkBuf = "";
let lastFinalText = "";
let liveCalls = new Map<string, any>();
let streaming = false;
let streamBuf = "";
let streamDiv: HTMLElement | null = null;
let unsub: (() => void) | null = null;
let sessCache: SessionInfo[] = [];

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

function el(tag: string, cls: string, html = ""): HTMLElement {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (html) d.innerHTML = html;
  return d;
}

// ---- message rendering (AgentMessage shapes) ----

function textOf(c: any): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .filter((b) => b && (b.type === "text" || typeof b.text === "string"))
      .map((b) => b.text ?? "")
      .join("");
  return "";
}

function msgNode(m: any, calls?: Map<string, any>, forkId?: string): HTMLElement {
  const role = m.role ?? "unknown";
  if (role === "user") {
    const box = el("div", "msg user");
    box.appendChild(el("div", "ubody", renderMd(textOf(m.content) || "(empty)")));
    const wrap = el("div", "umsgwrap");
    wrap.appendChild(box);
    // Overlay: no layout space, so the bubble hugs the text at 36px tall.
    const acts = el(
      "div",
      "actions overlay",
      `<button class="act-copy iconbtn" title="Copy">${ICO_COPY}</button>` +
        (forkId
          ? `<button class="act-revert iconbtn" data-entry="${forkId}" title="Revert to this message (forks the tree)">${ICO_REVERT}</button>`
          : "")
    );
    wrap.appendChild(acts);
    return wrap;
  }
  if (role === "assistant") {
    const box = el("div", "msg assistant");
    const blocks = Array.isArray(m.content) ? m.content : [];
    void CHEV;
    const text = blocks
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    if (text) {
      const body = el("div", "atext", renderMd(text));
      box.appendChild(body);
    }
    // Hover copy, same as user messages. Revert lives on user msgs only.
    box.appendChild(el("div", "actions overlay", `<button class="act-copy iconbtn" title="Copy">${ICO_COPY}</button>`));
    // Model already lives in the composer chip; stop reasons like toolUse are
    // routine. Surface only real problems.
    if (m.stopReason === "error" || m.stopReason === "aborted")
      box.appendChild(el("div", "meta warn", esc(m.errorMessage ?? `stopped: ${m.stopReason}`)));
    return box;
  }
  // One expandable row per tool call: "⚙ name" → ran-command + output.
  // No copy buttons anywhere in tool territory. `calls` maps toolCallId
  // to the ToolCall block (name + arguments) from the assistant turn.
  if (role === "toolResult") {
    const args = calls?.get(m.toolCallId);
    const ran = args?.arguments ? esc(JSON.stringify(args.arguments)).slice(0, 500) : "";
    const out = textOf(m.content).slice(0, 2000);
    const d = el("details", "toolrow");
    d.appendChild(el("summary", "tgsum", `\u2699 ${esc(m.toolName ?? "tool")}${m.isError ? ' <span class="toolerr">(error)</span>' : ""}`));
    if (ran) d.appendChild(el("div", "tgrun", `<code>${ran}</code>`));
    if (out) d.appendChild(el("div", "tgout", renderMd(out)));
    wireCopy(d);
    return d;
  }
  if (role === "bashExecution") {
    const d = el("details", "toolrow");
    d.appendChild(el("summary", "tgsum", `\u2699 bash`));
    d.appendChild(el("div", "tgrun", `<code>$ ${esc(m.command ?? "")}</code>`));
    if (m.output) d.appendChild(el("div", "tgout", `<pre><code>${esc(m.output.slice(0, 2000))}</code></pre>`));
    return d;
  }
  if (role === "compactionSummary" || role === "branchSummary") {
    return el("div", "msg sys", `<em>summary:</em> ${esc((m.summary ?? "").slice(0, 500))}`);
  }
  return el("div", "msg sys", esc(`[${role}]`));
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- streaming ----

const normText = (s: string): string => s.replace(/\s+/g, " ").trim();

function flushStream(finalText?: string) {
  if (!streamDiv) {
    streamBuf = "";
    return;
  }
  if (streamBuf && finalText && normText(streamBuf) === normText(finalText)) {
    // Streamed preview matches the authoritative message: drop the preview,
    // the full render below replaces it. Otherwise we'd show it twice.
    streamDiv.remove();
  } else if (streamBuf) {
    const n = el("div", "msg assistant", renderMd(streamBuf));
    streamDiv.replaceWith(n);
    wireCopy(n);
    n.scrollIntoView({ block: "end" });
  } else {
    streamDiv.remove();
  }
  streamDiv = null;
  streamBuf = "";
}

// Thinking indicator lives in the message flow, where the answer will
// stream — never parked in a separate row above the composer.
function showThinking() {
  hideThinking();
  const d = el("div", "msg thinking-row", THINKING_DOTS);
  d.id = "runstatus";
  $("msgs").appendChild(d);
  d.scrollIntoView({ block: "end" });
}
function hideThinking() {
  $("runstatus")?.remove();
}

function route(rec: any) {
  if (!rec) return;
  // Streaming deltas (wire records are delta-only).
  if (rec.type === "message_update") {
    const ev = rec.assistantMessageEvent ?? {};
    if (ev.type === "text_delta" && typeof ev.delta === "string") {
      // Dots stay until the final answer (agent_settled), even while text
      // streams or tools run in gaps. No flicker clearing anywhere else.
      // First token takes the indicator's place in the flow.
      if (streamBuf === "") hideThinking();
      streamBuf += ev.delta;
      if (!streamDiv) {
        streamDiv = el("div", "msg assistant stream");
        $("msgs").appendChild(streamDiv);
      }
      streamDiv.innerHTML = renderMd(streamBuf);
      streamDiv.scrollIntoView({ block: "end" });
    } else if (ev.type === "toolcall_start") {
      showThinking();
    } else if (typeof ev.type === "string" && ev.type.includes("think")) {
      const d = (ev as any).delta ?? (ev as any).text ?? "";
      if (typeof d === "string" && d) {
        if (!liveThinkDiv) {
          liveRun = runAppend($("msgs"), liveRun, thoughtDiv(""));
          liveThinkDiv = (liveRun as HTMLElement).querySelector(".tgbody > .runthought:last-child");
          liveThinkBuf = "";
        }
        liveThinkBuf += d;
        if (liveThinkDiv) liveThinkDiv.innerHTML = renderMd(liveThinkBuf.slice(-4000));
      }
    }
    return;
  }
  // Authoritative completed message (top-level per json.md).
  if (rec.type === "message_end" && rec.message) {
    flushStream(rec.message.role === "assistant" ? textOf(rec.message.content) : undefined);
    if (rec.message.role === "system") return;
    // Remember ToolCall args so rows can show what ran.
    if (rec.message.role === "assistant" && Array.isArray(rec.message.content)) {
      for (const b of rec.message.content) {
        if (b && b.type === "toolCall" && b.id) liveCalls.set(b.id, b);
      }
      // Full thinking blocks replace the live-streamed partial version.
      liveThinkDiv?.remove();
      liveThinkDiv = null;
      liveThinkBuf = "";
    }
    if (rec.message.role === "user") {
      liveRun = null;
      // Already shown optimistically at send time; skip the echo.
      if (pendingUser && textOf(rec.message.content) === pendingUser) {
        pendingUser = "";
        return;
      }
      pendingUser = "";
    }
    if (rec.message.role === "assistant" && Array.isArray(rec.message.content)) {
      for (const b of rec.message.content) {
        if (b && b.type === "thinking" && b.thinking) {
          liveRun = runAppend($("msgs"), liveRun, thoughtDiv(b.thinking));
        }
      }
    }
    if (rec.message.role === "toolResult" || rec.message.role === "bashExecution") {
      liveRun = runAppend($("msgs"), liveRun, msgNode(rec.message, liveCalls));
      (liveRun as HTMLElement).scrollIntoView({ block: "end" });
      return;
    }
    if (rec.message.role === "assistant" && !textOf(rec.message.content)) return;
    // Guard: never render the same assistant text twice in a row
    // (streaming prediction vs final, or repeated turns, can double up).
    // Normalized: a trailing newline must not defeat it.
    if (rec.message.role === "assistant") {
      const ft = normText(textOf(rec.message.content));
      if (ft && ft === normText(lastFinalText)) return;
      if (ft) lastFinalText = ft;
    }
    const n = msgNode(rec.message, liveCalls);
    $("msgs").appendChild(n);
    wireCopy(n);
    n.scrollIntoView({ block: "end" });
    return;
  }
  if (rec.type === "tool_execution_start") {
    showThinking();
    return;
  }
  if (rec.type === "tool_execution_end") {
    // Intentionally left showing: thinking runs till the final answer.
    return;
  }
  if (rec.type === "agent_settled") {
    finishRun();
    return;
  }
}

const THINKING_DOTS = `<span class="thinking" aria-label="thinking"><i></i><i></i><i></i></span>`;

function startRun() {
  streaming = true;
  streamBuf = "";
  ($("send") as HTMLButtonElement).disabled = true;
  ($("abortbtn") as HTMLButtonElement).disabled = false;
  showThinking();
}

const autoNamed = new Set<string>();

// ChatGPT auto-titles chats: name an unnamed session from its first prompt.
async function maybeAutoName() {
  try {
    const s = await pi.state(cwd);
    if (s.sessionName || !s.sessionFile || autoNamed.has(s.sessionFile)) return;
    const data = await pi.messages(cwd);
    const first = (data.messages ?? []).find((m: any) => m.role === "user");
    const raw = typeof first?.content === "string" ? first.content : "";
    const text = raw.split(/\s+/).slice(0, 6).join(" ").slice(0, 48);
    if (!text) return;
    autoNamed.add(s.sessionFile);
    await pi.setName(cwd, text);
  } catch { /* best effort */ }
}

function finishRun() {
  streaming = false;
  if (streamDiv && streamBuf) {
    // No message_end arrived: flush what we streamed.
    const n = el("div", "msg assistant", renderMd(streamBuf));
    streamDiv.replaceWith(n);
    wireCopy(n);
  }
  streamDiv = null;
  streamBuf = "";
  ($("send") as HTMLButtonElement).disabled = false;
  ($("abortbtn") as HTMLButtonElement).disabled = true;
  hideThinking();
  maybeAutoName().finally(() => refreshLight());
}

// ---- data loading ----

// Optimistic entry for the session being written: pi only materializes
// the file on first model activity, but the user hit send *now*, so show
// it now (keyed by the real session file from live state).
let pendingNew: { path: string; title: string } | null = null;

async function refreshSessions() {
  try {
    sessCache = await sessions.list(cwd);
  } catch {
    sessCache = [];
    return;
  }
  if (pendingNew) {
    if (sessCache.some((x) => x.path === pendingNew!.path)) {
      pendingNew = null; // file landed: real entry takes over
    } else {
      try {
        const s: any = await pi.state(cwd);
        if (s?.sessionFile === pendingNew.path) {
          sessCache.unshift({
            path: pendingNew.path,
            id: s.sessionId ?? "",
            timestamp: new Date().toISOString(),
            cwd,
            name: pendingNew.title,
            preview: null,
          });
        } else {
          pendingNew = null; // switched away: drop the ghost
        }
      } catch { /* pi starting */ }
    }
  }
  const f = ($("sessfilter") as HTMLInputElement).value.toLowerCase();
  const list = $("sesslist");
  list.innerHTML = "";
  for (const s of sessCache) {
    const label = `${s.name ?? ""} ${s.id.slice(0, 8)} ${s.timestamp}`.toLowerCase();
    if (f && !label.includes(f)) continue;
    const d = el(
      "div",
      "sess" + (s.path === (list as any)._active ? " active" : ""),
      `<div class="stitle">${esc(titleText(s))}</div>` +
        `<div class="ssub">${esc(subText(s))}</div>`
    );
    d.title = s.path;
    d.addEventListener("click", () => switchSession(s.path));
    const del = el("button", "sdel", "×");
    del.title = "Delete session file";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Delete this session file?")) return;
      const wasActive = s.path === curFile;
      try {
        await sessions.del(s.path);
      } catch (e: any) {
        alert(`delete failed: ${e.message ?? e}`);
        return;
      }
      // Deleting the viewed session: stop its child (it keeps running
      // otherwise, orphaned) and open a fresh one.
      try {
        await stopChild(cwd, s.path).catch(() => {});
      } catch { /* no child */ }
      if (wasActive) {
        try {
          resetRunState();
          await openFresh();
        } catch { /* fall through to refresh */ }
        refreshAll(false);
        return;
      }
      refreshSessions();
    });
    d.appendChild(del);
    list.appendChild(d);
  }
}

const ICO_COPY = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="6.5" y="6.5" width="10" height="10" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M13.5 6.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" stroke="currentColor" stroke-width="1.5"/></svg>`;
const ICO_REVERT = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3.5 8a6.5 6.5 0 1 1-1 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M3.5 3.5V8H8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ChatGPT-style titles: explicit /name wins, else first words of first prompt.
function titleText(s: SessionInfo): string {
  if (s.name) return s.name;
  const auto = (s.preview ?? "").split(/\s+/).slice(0, 6).join(" ").slice(0, 48);
  return auto || s.id.slice(0, 8);
}
function subText(s: SessionInfo): string {
  if (s.name) return (s.preview ?? "").slice(0, 90) || stamp(s);
  return stamp(s);
}
function stamp(s: SessionInfo): string {
  return s.timestamp.replace("T", " ").slice(0, 19);
}

// One collapsed "Activity" container per user request: thoughts and tool
// rows interleaved in chronological order. No counts, no copy buttons.
function runAppend(box: HTMLElement, run: HTMLElement | null, item: HTMLElement): HTMLElement {
  if (!run) {
    run = el("details", "runact");
    run.appendChild(el("summary", "tgsum", `Activity ${CHEV}`));
    run.appendChild(el("div", "tgbody"));
    box.appendChild(run);
  }
  run.querySelector(".tgbody")!.appendChild(item);
  return run;
}

function thoughtDiv(text: string): HTMLElement {
  return el("div", "runthought", renderMd(text.slice(0, 4000)));
}

const CHEV = `<svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

async function refreshMsgs() {
  const box = $("msgs");
  box.innerHTML = "";
  try {
    const data = await pi.messages(cwd);
    const arr = data.messages ?? [];
    // Entry ids so each sent message gets copy + revert (fork) actions.
    // Matched by text (order-independent): index mapping breaks if pi ever
    // returns entries in any other order.
    let forkByText = new Map<string, string[]>();
    try {
      const fm: any = await pi.forkMessages(cwd);
      for (const e of fm.messages ?? []) {
        if (e?.entryId && typeof e?.text === "string") {
          const k = e.text;
          if (!forkByText.has(k)) forkByText.set(k, []);
          forkByText.get(k)!.push(e.entryId);
        }
      }
    } catch { /* forks unavailable */ }
    const takeForkId = (text: string): string | undefined => {
      const q = forkByText.get(text);
      return q?.length ? (q.shift() as string) : undefined;
    };
    // Index ToolCall blocks so rows can show what ran.
    const calls = new Map<string, any>();
    for (const m of arr) {
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b && b.type === "toolCall" && b.id) calls.set(b.id, b);
      }
    }
    let shown = 0;
    let run: HTMLElement | null = null;
    let prevAssistant = "";
    const isTool = (m: any) => m.role === "toolResult" || m.role === "bashExecution";
    for (const m of arr) {
      if (m.role === "system") continue;
      if (m.role === "user") prevAssistant = "";
      // One Activity container per user request: thoughts and tool rows
      // interleave chronologically. A new user message starts a new one.
      if (m.role === "user") run = null;
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b && b.type === "thinking" && b.thinking) {
            run = runAppend(box, run, thoughtDiv(b.thinking));
          }
        }
      }
      if (isTool(m)) {
        run = runAppend(box, run, msgNode(m, calls));
        shown++;
        continue;
      }
      // Textless assistant turns (tool-call-only) would flash as empty
      // boxes; their content already lives in the Activity container.
      if (m.role === "assistant" && !textOf(m.content)) continue;
      // Consecutive near-identical assistant turns (retries/replays) render
      // once. Normalized so trailing whitespace can't defeat it.
      if (m.role === "assistant") {
        const t = normText(textOf(m.content));
        if (t && t === prevAssistant) continue;
        if (t) prevAssistant = t;
      }
      const fid = m.role === "user" ? takeForkId(textOf(m.content)) : undefined;
      const n = msgNode(m, calls, fid);
      box.appendChild(n);
      shown++;
    }
    if (!shown) {
      const g = el("div", "greet", `<h2>Ready when you are.</h2>`);
      box.appendChild(g);
    }
    wireCopy(box);
    box.scrollTop = box.scrollHeight;
  } catch (e: any) {
    box.appendChild(el("div", "msg sys", esc(`could not load messages: ${e.message ?? e}`)));
  }
}

let curFile: string | null = null;

async function refreshState() {
  try {
    const s = await pi.state(cwd);
    curFile = s.sessionFile ?? null;
    const cached = sessCache.find((x) => x.path === s.sessionFile);
    $("sesstitle").textContent =
      s.sessionName ?? (cached ? titleText(cached) : null) ?? "New chat";
    (listActive(s.sessionFile));
    if (s.model) syncModelSelect(s.model, s.thinkingLevel);
  } catch {
    /* pi may be starting */
  }
}

function listActive(path?: string) {
  ( $("sesslist") as any)._active = path ?? null;
  document.querySelectorAll("#sesslist .sess").forEach((d) => {
    d.classList.toggle("active", (d as HTMLElement).title === path);
  });
}

let allModels: any[] = [];
let allLevels: string[] = [];

// Arrow-key navigation shared by every custom menu. Moves a highlight
// among visible options; Enter picks highlighted (else first visible).
function menuMove(list: HTMLElement, dir: 1 | -1): void {
  const vis = Array.from(list.querySelectorAll(".dd-opt[data-v]")) as HTMLElement[];
  const open = vis.filter((o) => o.offsetParent !== null);
  if (!open.length) return;
  let i = open.findIndex((o) => o.classList.contains("hl"));
  if (i < 0) {
    // No highlight yet: start from the current selection, then step.
    const cur = open.findIndex((o) => o.classList.contains("cur"));
    i = cur < 0 ? (dir > 0 ? -1 : open.length) : cur;
  }
  i = Math.min(Math.max(i + dir, 0), open.length - 1);
  open.forEach((o) => o.classList.remove("hl"));
  open[i].classList.add("hl");
  open[i].scrollIntoView({ block: "nearest" });
}
function menuPick(list: HTMLElement): void {
  const hl = list.querySelector(".dd-opt.hl[data-v]") as HTMLElement | null;
  const first = list.querySelector(".dd-opt[data-v]") as HTMLElement | null;
  (hl ?? first)?.click();
}

function closeDrops() {
  $("modellist").classList.add("hidden");
  $("thinklist").classList.add("hidden");
  $("dirlist").classList.add("hidden");
  $("modelbtn").classList.remove("open");
  $("thinkbtn").classList.remove("open");
  $("dirbtn").classList.remove("open");
}

function syncModelSelect(cur: any, thinking?: string) {
  const id = `${cur.provider}/${cur.id ?? cur.modelId ?? ""}`;
  curModelId = id;
  const m = allModels.find((x) => `${x.provider}/${x.id}` === id);
  $("modellabel").textContent = m?.name ?? m?.id ?? id;
  markCurModel();
  if (thinking) $("thinklabel").textContent = thinking;
  document.querySelectorAll("#thinklist .dd-opt").forEach((d) =>
    d.classList.toggle("cur", (d as HTMLElement).dataset.v === (thinking ?? $("thinklabel").textContent))
  );
}

// Visible search over the (large) model list. Filters as you type,
// Enter picks the first visible match.
function renderModelOpts() {
  const ml = $("modelopts");
  ml.innerHTML = "";
  const q = (($("modeltype") as HTMLInputElement).value || "").toLowerCase();
  const shown = allModels.filter((m) => {
    const hay = `${m.name ?? ""} ${m.provider ?? ""} ${m.id ?? ""}`.toLowerCase();
    return !q || hay.includes(q);
  });
  for (const m of shown) {
    const v = `${m.provider}/${m.id}`;
    const o = el("div", "dd-opt", esc(m.name ?? m.id));
    (o as HTMLElement).dataset.v = v;
    o.addEventListener("click", async () => {
      closeDrops();
      try {
        await pi.setModel(cwd, m.provider, m.id);
      } catch (err: any) {
        alert(`model switch failed: ${err.message ?? err}`);
      }
      refreshModels();
    });
    ml.appendChild(o);
  }
  if (!shown.length) ml.appendChild(el("div", "dd-opt", allModels.length ? "(no match)" : "(models unavailable)"));
  markCurModel();
}

let curModelId = "";

function markCurModel() {
  document.querySelectorAll("#modelopts .dd-opt").forEach((d) =>
    d.classList.toggle("cur", (d as HTMLElement).dataset.v === curModelId)
  );
}

async function refreshModels() {
  try {
    const data = await pi.models(cwd);
    allModels = data.models ?? [];
  } catch {
    allModels = [];
  }
  renderModelOpts();
  try {
    const data = await pi.thinkingLevels(cwd);
    allLevels = data.levels ?? ["off"];
  } catch {
    allLevels = ["off"];
  }
  renderThinkOpts();
  await refreshState();
}

function renderThinkOpts() {
  const tl = $("thinkopts");
  tl.innerHTML = "";
  const q = (($("thinktype") as HTMLInputElement).value || "").toLowerCase();
  const shown = allLevels.filter((l) => !q || l.toLowerCase().includes(q));
  for (const l of shown) {
    const o = el("div", "dd-opt", esc(l));
    (o as HTMLElement).dataset.v = l;
    o.addEventListener("click", async () => {
      closeDrops();
      try {
        await pi.setThinking(cwd, l);
      } catch (err: any) {
        alert(`thinking switch failed: ${err.message ?? err}`);
      }
      refreshModels();
    });
    tl.appendChild(o);
  }
  if (!shown.length) tl.appendChild(el("div", "dd-opt", "(no match)"));
  const cur = $("thinklabel").textContent;
  tl.querySelectorAll(".dd-opt").forEach((d) =>
    d.classList.toggle("cur", (d as HTMLElement).dataset.v === cur)
  );
}

function refreshAll(withModels: boolean) {
  refreshSessions();
  refreshMsgs();
  if (withModels) refreshModels();
  else refreshState();
}

// Light refresh: sidebar + header only. The live stream already built the
// transcript in place; rebuilding it here flashes the whole view.
function refreshLight() {
  refreshSessions();
  refreshState();
}

// Viewing another session must never disturb running ones: no aborts here.
// Each session owns its pi child; switching only repoints this window at a
// different child and re-renders. Local partial UI is reset so a stale
// stream doesn't linger in the new view.

async function doRevert(entryId: string) {
  try {
    resetRunState();
    const before = curFile;
    const oldKey = viewKey;
    const r: any = await pi.fork(cwd, entryId);
    if (r?.cancelled) return;
    const file = await awaitSession(cwd, before);
    // The fork switched this child; retire it and open a dedicated child
    // so the key always means the file it names.
    await stopChild(cwd, oldKey).catch(() => {});
    if (file) {
      await ensure(cwd, file, file);
      setKey(file);
      viewKey = file;
      curFile = file;
    }
    await refreshAll(false);
    if (r?.text) {
      const inp = $("input") as HTMLTextAreaElement;
      inp.value = r.text;
      inp.style.height = "auto";
      inp.style.height = Math.min(inp.scrollHeight, 200) + "px";
      inp.focus();
    }
  } catch (err: any) {
    alert(`revert failed: ${err.message ?? err}`);
  }
}

// Local run state must die with the session: settled events arriving
// across a switch gap otherwise leave streaming stuck (dead UI) or bleed
// the old run into the new session's view.
function resetRunState() {
  streaming = false;
  streamDiv?.remove();
  streamDiv = null;
  streamBuf = "";
  liveRun = null;
  liveThinkDiv = null;
  liveThinkBuf = "";
  lastFinalText = "";
  pendingUser = "";
  ($("send") as HTMLButtonElement).disabled = false;
  ($("abortbtn") as HTMLButtonElement).disabled = true;
  hideThinking();
}

// Viewing key: backend child this window currently talks to. For saved
// sessions it is the session file; for unsaved ones a fresh id.
let viewKey = "";
let viewPath: string | null = null;

// Fresh backend child for a brand-new session. The file only materializes
// on first model activity; the poll pins the filename for the sidebar.
async function openFresh(): Promise<void> {
  const key = `fresh-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  await ensure(cwd, key, null);
  setKey(key);
  viewKey = key;
  viewPath = null;
  const before: string | null = await pi.state(cwd).then((s: any) => s?.sessionFile ?? null).catch(() => null);
  await pi.newSession(cwd);
  const file = await awaitSession(cwd, before);
  curFile = file;
  pendingNew = file ? { path: file, title: "New chat" } : null;
}

async function switchSession(path: string) {
  try {
    resetRunState();
    await ensure(cwd, path, path);
    setKey(path);
    viewKey = path;
    viewPath = path;
    curFile = path;
    await syncRunFlag();
  } catch (e: any) {
    alert(`switch failed: ${e.message ?? e}`);
    return;
  }
  refreshAll(false);
}

// If the session we just opened is still running server-side, reflect it
// locally so the composer locks and completion settles normally.
async function syncRunFlag() {
  try {
    const s: any = await pi.state(cwd);
    if (s?.isStreaming) {
      streaming = true;
      ($("send") as HTMLButtonElement).disabled = true;
      ($("abortbtn") as HTMLButtonElement).disabled = false;
      showThinking();
    }
  } catch { /* ignore */ }
}

async function send() {
  const inp = $("input") as HTMLTextAreaElement;
  const text = inp.value.trim();
  if (!text || streaming) return;
  inp.value = "";
  inp.style.height = "auto";
  liveRun = null;
  liveThinkDiv = null;
  liveThinkBuf = "";
  lastFinalText = "";
  liveCalls = new Map<string, any>();
  // Clear the greeting immediately and show the message at once; the
  // echoed user message_end later is then skipped (see route).
  pendingUser = text;
  $("msgs").querySelector(".greet")?.remove();
  {
    const box = el("div", "msg user");
    box.appendChild(el("div", "ubody", renderMd(text)));
    const wrap = el("div", "umsgwrap");
    wrap.appendChild(box);
    wrap.appendChild(el("div", "actions overlay", `<button class="act-copy iconbtn" title="Copy">${ICO_COPY}</button>`));
    $("msgs").appendChild(wrap);
    $("msgs").scrollTop = $("msgs").scrollHeight;
  }
  startRun();
  try {
    await ensure(cwd, viewKey || undefined, viewPath);
    if (viewKey) setKey(viewKey);
  } catch (e: any) {
    $("msgs").appendChild(el("div", "msg sys", esc(`pi failed to start: ${e.message ?? e}`)));
    finishRun();
    return;
  }
  // Register the about-to-be-written session immediately.
  pi.state(cwd).then((s: any) => {
    if (s?.sessionFile) {
      pendingNew = {
        path: s.sessionFile,
        title: s.sessionName ?? text.split(/\s+/).slice(0, 6).join(" ").slice(0, 48) ?? "New chat",
      };
      refreshSessions();
    }
  }).catch(() => {});
  try {
    await pi.prompt(cwd, text);
    // completion arrives via agent_settled; safety net:
    setTimeout(() => {
      if (streaming) finishRun();
    }, 180_000);
  } catch (e: any) {
    $("msgs").appendChild(el("div", "msg sys", esc(`send failed: ${e.message ?? e}`)));
    finishRun();
  }
  persistLastCwd();
}

async function persistLastCwd() {
  try {
    await config.set({ last_cwd: cwd });
  } catch { /* ignore */ }
}

function baseName(p: string): string {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return (i < 0 ? t : t.slice(i + 1)) || t;
}

let cwdGen = 0;

async function setCwd(next: string, save = true) {
  const gen = ++cwdGen;
  cwd = next;
  resetRunState();
  $("dirlabel").textContent = baseName(cwd) || cwd;
  ($("dirbtn") as HTMLButtonElement).title = cwd;
  syncDirMenu();
  unsub?.();
  try {
    const files = await sessions.list(cwd).catch(() => []);
    if (gen !== cwdGen) return;
    if (files.length) {
      // Continue the most recent session in its own child.
      const f = files[0].path;
      await ensure(cwd, f, f);
      if (gen !== cwdGen) return;
      setKey(f);
      viewKey = f;
      viewPath = f;
      curFile = f;
    } else {
      await openFresh();
      if (gen !== cwdGen) return;
    }
  } catch (e: any) {
    $("msgs").innerHTML = "";
    $("msgs").appendChild(el("div", "msg sys", esc(`pi failed to start in ${cwd}: ${e.message ?? e}. Is pi on PATH?`)));
    return;
  }
  if (gen !== cwdGen) return; // superseded by a newer switch
  unsub = onRecord(cwd, route);
  if (save) {
    try {
      const c = await config.get();
      const recents = [cwd, ...c.recents.filter((d) => d !== cwd)].slice(0, 12);
      await config.set({ last_cwd: cwd, recents });
    } catch { /* ignore */ }
    syncDirMenu();
  }
  refreshAll(true);
  await syncRunFlag();
}

// Directory menu: recents + visible type-to-use field + browse. Same
// custom-menu chrome as the model/thinking dropdowns, no native popups.
function syncDirMenu() {
  $("dirlabel").textContent = baseName(cwd) || cwd;
  ($("dirbtn") as HTMLButtonElement).title = cwd;
  renderDirRecents();
}

function renderDirRecents() {
  config.get().then((c) => {
    const box = $("dirrecents");
    box.innerHTML = "";
    const q = (($("dirtype") as HTMLInputElement).value || "").toLowerCase();
    const defDir = c.default_dir;
    const opts = [defDir, ...c.recents.filter((d) => d !== defDir)];
    const seen = new Set<string>();
    for (const d of [cwd, ...opts]) {
      if (!d || seen.has(d)) continue;
      seen.add(d);
      if (q && !d.toLowerCase().includes(q)) continue;
      const o = el("div", "dd-opt dirrow2");
      const label = el("span", "dd-dirname", esc(d));
      label.addEventListener("click", () => {
        closeDrops();
        setCwd(d);
      });
      o.appendChild(label);
      if (d !== cwd && d !== defDir) {
        const x = el("button", "ddx", "×");
        x.title = "Remove from recents";
        x.addEventListener("click", async (e) => {
          e.stopPropagation();
          try {
            const cc = await config.get();
            await config.set({ recents: cc.recents.filter((r) => r !== d) });
          } catch { /* ignore */ }
          renderDirRecents();
        });
        o.appendChild(x);
      }
      box.appendChild(o);
    }
  }).catch(() => {});
}

// ---- settings ----

async function openSettings() {
  $("appver").textContent = `v${__APP_VERSION__}`;
  const c = await config.get();
  ($("cfg-quick") as HTMLInputElement).value = c.quickbar_hotkey;
  ($("cfg-main") as HTMLInputElement).value = c.main_hotkey;
  ($("cfg-dir") as HTMLInputElement).value = c.default_dir;
  ($("cfg-bg") as HTMLInputElement).checked = c.run_in_bg !== false;
  $("cfgerr").textContent = "";
  $("settingsmodal").classList.remove("hidden");
}

// ---- boot ----

  // Hover action bars: copy message text (Claude-style, hover-only).
  // Revert: fork the tree at that message, drop its text back in the
  // composer for editing. Sending forks a branch (shows "No summary"
  // in pi's tree view until pi summarizes the abandoned branch).
  document.addEventListener("click", async (e) => {
    const rv = (e.target as HTMLElement).closest?.(".act-revert") as HTMLButtonElement | null;
    if (rv?.dataset.entry) {
      e.stopPropagation();
      await doRevert(rv.dataset.entry);
      return;
    }
    const b = (e.target as HTMLElement).closest?.(".act-copy") as HTMLButtonElement | null;
    if (!b) return;
    const msg = b.closest(".msg");
    const text = msg?.textContent?.trim() ?? "";
    const orig = b.innerHTML;
    try {
      await navigator.clipboard.writeText(text);
      b.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4 10.5l4 4 7-8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      b.title = "Copied";
      setTimeout(() => {
        b.innerHTML = orig;
        b.title = "Copy";
      }, 1200);
    } catch { /* ignore */ }
  });

window.addEventListener("DOMContentLoaded", async () => {
  setTag("main");
  ($("send") as HTMLButtonElement).addEventListener("click", send);
  ($("abortbtn") as HTMLButtonElement).addEventListener("click", async () => {
    try {
      await pi.abort(cwd);
    } catch { /* ignore */ }
  });
  const inp = $("input") as HTMLTextAreaElement;
  const autogrow = () => {
    inp.style.height = "auto";
    inp.style.height = Math.min(inp.scrollHeight, 200) + "px";
  };
  inp.addEventListener("input", autogrow);
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape") {
      pi.abort(cwd).catch(() => {});
    }
  });
  ($("newsess") as HTMLButtonElement).addEventListener("click", async () => {
    resetRunState();
    try {
      await openFresh();
    } catch (e: any) {
      alert(`new chat failed: ${e.message ?? e}`);
      return;
    }
    refreshAll(false);
  });
  ($("searchbtn") as HTMLButtonElement).addEventListener("click", () => {
    ($("sessfilter") as HTMLInputElement).focus();
  });
  ($("collapsebtn") as HTMLButtonElement).addEventListener("click", () => {
    document.body.classList.add("side-collapsed");
    ($("expandbtn") as HTMLButtonElement).classList.remove("hidden");
  });
  ($("expandbtn") as HTMLButtonElement).addEventListener("click", () => {
    document.body.classList.remove("side-collapsed");
    ($("expandbtn") as HTMLButtonElement).classList.add("hidden");
  });
  const msgs = $("msgs");
  const scroller = () => {
    const away = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight;
    ($("scrollbtn") as HTMLButtonElement).classList.toggle("hidden", away < 200);
  };
  msgs.addEventListener("scroll", scroller);
  ($("scrollbtn") as HTMLButtonElement).addEventListener("click", () => {
    msgs.scrollTop = msgs.scrollHeight;
    ($("scrollbtn") as HTMLButtonElement).classList.add("hidden");
  });
  ($("sessfilter") as HTMLInputElement).addEventListener("input", refreshSessions);
  ($("dirbtn") as HTMLButtonElement).addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = $("dirlist").classList.contains("hidden");
    closeDrops();
    if (opening) {
      $("dirlist").classList.remove("hidden");
      ($("dirbtn") as HTMLButtonElement).classList.add("open");
      renderDirRecents();
      ($("dirtype") as HTMLInputElement).focus();
    }
  });
  ($("dirlist") as HTMLElement).addEventListener("click", (e) => e.stopPropagation());
  ($("dirtype") as HTMLInputElement).addEventListener("click", (e) => e.stopPropagation());
  ($("dirtype") as HTMLInputElement).addEventListener("input", renderDirRecents);
  ($("dirtype") as HTMLInputElement).addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      menuMove($("dirrecents"), e.key === "ArrowDown" ? 1 : -1);
      e.preventDefault();
    } else if (e.key === "Enter") {
      const hl = $("dirrecents").querySelector(".dd-opt.hl") as HTMLElement | null;
      if (hl) {
        hl.querySelector(".dd-dirname")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return;
      }
      const v = (e.target as HTMLInputElement).value.trim();
      if (v) {
        closeDrops();
        setCwd(v);
      }
    } else if (e.key === "Escape") {
      closeDrops();
    }
  });
  ($("dirbrowse") as HTMLButtonElement).addEventListener("click", async () => {
    closeDrops();
    const picked: string | null = await invoke("pick_dir");
    if (picked) setCwd(picked);
  });
  ($("modelbtn") as HTMLButtonElement).addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = $("modellist").classList.contains("hidden");
    closeDrops();
    if (opening) {
      $("modellist").classList.remove("hidden");
      ($("modelbtn") as HTMLButtonElement).classList.add("open");
      renderModelOpts();
      ($("modeltype") as HTMLInputElement).focus();
    }
  });
  ($("modellist") as HTMLElement).addEventListener("click", (e) => e.stopPropagation());
  ($("modeltype") as HTMLInputElement).addEventListener("click", (e) => e.stopPropagation());
  ($("modeltype") as HTMLInputElement).addEventListener("input", renderModelOpts);
  ($("modeltype") as HTMLInputElement).addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      menuMove($("modelopts"), e.key === "ArrowDown" ? 1 : -1);
      e.preventDefault();
    } else if (e.key === "Enter") {
      menuPick($("modelopts"));
    } else if (e.key === "Escape") {
      closeDrops();
    }
  });
  ($("thinkbtn") as HTMLButtonElement).addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = $("thinklist").classList.contains("hidden");
    closeDrops();
    if (opening) {
      $("thinklist").classList.remove("hidden");
      ($("thinkbtn") as HTMLButtonElement).classList.add("open");
      renderThinkOpts();
      ($("thinktype") as HTMLInputElement).focus();
    }
  });
  ($("thinklist") as HTMLElement).addEventListener("click", (e) => e.stopPropagation());
  ($("thinktype") as HTMLInputElement).addEventListener("click", (e) => e.stopPropagation());
  ($("thinktype") as HTMLInputElement).addEventListener("input", renderThinkOpts);
  ($("thinktype") as HTMLInputElement).addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      menuMove($("thinkopts"), e.key === "ArrowDown" ? 1 : -1);
      e.preventDefault();
    } else if (e.key === "Enter") {
      menuPick($("thinkopts"));
    } else if (e.key === "Escape") {
      closeDrops();
    }
  });
  document.addEventListener("click", () => closeDrops());
  // Invisible type-ahead for open menus (native-select behavior): focus a
  // menu button, type to jump, Enter picks, Esc closes. No text field.
  let typeBuf = "";
  let typeTimer: number | null = null;
  document.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    for (const id of ["modellist", "thinklist"]) {
      const list = $(id);
      if (list.classList.contains("hidden")) continue;
      if (e.key === "Escape") {
        closeDrops();
        typeBuf = "";
        e.preventDefault();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        menuMove(list, e.key === "ArrowDown" ? 1 : -1);
        e.preventDefault();
        return;
      }
      if (e.key === "Enter") {
        menuPick(list);
        e.preventDefault();
        return;
      }
      if (e.key === "Backspace") {
        typeBuf = typeBuf.slice(0, -1);
      } else if (e.key.length === 1) {
        typeBuf += e.key.toLowerCase();
      } else {
        continue;
      }
      if (typeTimer) window.clearTimeout(typeTimer);
      typeTimer = window.setTimeout(() => (typeBuf = ""), 800);
      const opts = Array.from(list.querySelectorAll(".dd-opt")) as HTMLElement[];
      opts.forEach((o) => o.classList.remove("hl"));
      const hit = opts.find((o) => (o.textContent ?? "").trim().toLowerCase().startsWith(typeBuf));
      hit?.classList.add("hl");
      hit?.scrollIntoView({ block: "nearest" });
      return;
    }
  });
  ($("settingsbtn") as HTMLButtonElement).addEventListener("click", openSettings);
  ($("cfgclose") as HTMLButtonElement).addEventListener("click", () =>
    $("settingsmodal").classList.add("hidden")
  );
  ($("cfgsave") as HTMLButtonElement).addEventListener("click", async () => {
    try {
      await config.set({
        quickbar_hotkey: ($("cfg-quick") as HTMLInputElement).value.trim(),
        main_hotkey: ($("cfg-main") as HTMLInputElement).value.trim(),
        default_dir: ($("cfg-dir") as HTMLInputElement).value.trim(),
        run_in_bg: ($("cfg-bg") as HTMLInputElement).checked,
      });
      $("settingsmodal").classList.add("hidden");
    } catch (e: any) {
      $("cfgerr").textContent = `save failed: ${e.message ?? e}`;
    }
  });

  // Quickbar "open in sessions" handoff.
  listen("open-request", async (e: any) => {
    const p = e.payload ?? {};
    if (p.cwd && p.cwd !== cwd) await setCwd(p.cwd);
    if (p.sessionPath) await switchSession(p.sessionPath);
  }).catch(() => {});

  const c = await config.get();
  await setCwd(c.last_cwd || c.default_dir, false);
});
