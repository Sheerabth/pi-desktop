// Sessions window: sidebar (dir + sessions), chat, model/thinking pickers,
// settings (hotkeys). Thin view over pi RPC — pi owns everything.

import { invoke } from "./tauri-shim";
import { listen } from "./tauri-shim";
import { awaitSession, config, ensure, onRecord, pi, sessions, setKey, setTag, stopChild, type SessionInfo } from "./pi";

// Shown in Settings so installed-vs-running is checkable. Value comes
// from package.json via vite define (single source, see vite.config.ts).
import { renderMd, setMediaBase, clearMediaCache, wireCopy } from "./md";

let cwd = "";
let liveRun: HTMLElement | null = null;
let liveThinkDiv: HTMLElement | null = null;
let liveThinkBuf = "";
let liveCalls = new Map<string, any>();
let streaming = false;
// True from a follow-up transmit until the agent's next output. Bridges
// the dead air between turn A settling and turn B's first token: without
// it the UI looks idle although your message is accepted and queued.
// One-shot (consumed by finishRun); cleared by any agent output, by
// abort, and by a 90s safety timer. Cosmetic only, never drives runs.
let awaitingResponse = false;
let streamBuf = "";
let streamDiv: HTMLElement | null = null;
let lastStreamWire = 0; // throttle: full wire at most every ~1.5s mid-stream
let unsub: (() => void) | null = null;
let sessCache: SessionInfo[] = [];

// ---- ChatGPT chat dynamics ----
let stick = true; // pinned to bottom unless the user scrolls up
const ICO_STOP = `<svg width="14" height="14" viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor"/></svg>`;
const ICO_SEND = `↑`;
function pin() {
  if (!stick) return;
  const m = $("scrollwrap");
  m.scrollTop = m.scrollHeight;
}
// Late media bytes extend the page under a pinned viewport (the #1
// autoscroll miss: text pinned fine, then images landed below it).
window.addEventListener("pi-media-settled", pin);
// Single-button Send<->Stop morph, ChatGPT-style. The separate #abortbtn
// is hidden (see styles.css); the composer button does both jobs.
function syncSendBtn() {
  const inp = document.getElementById("input") as HTMLTextAreaElement | null;
  const btn = document.getElementById("send") as HTMLButtonElement | null;
  if (!inp || !btn) return;
  if (streaming) {
    btn.disabled = false;
    btn.dataset.mode = "stop";
    btn.innerHTML = ICO_STOP;
    btn.title = "Stop";
  } else {
    btn.dataset.mode = "send";
    btn.innerHTML = ICO_SEND;
    btn.title = "Send";
    btn.disabled = !inp.value.trim();
  }
}
// Mirror of pi's own queue, data-driven (see renderQueued). queue_update
// carries the live {steering[], followUp[]} arrays; cleared on view
// switch and refined by syncRunFlag's pendingMessageCount.
type AgentQueue = { steering: string[]; followUp: string[] };
let lastQueue: AgentQueue | null = null;
// Fire-and-forget stop (button/Escape). Completion settles via agent_settled.
function stopOnly() {
  awaitingResponse = false;
  try {
    pi.abort(cwd).catch(() => {});
  } catch { /* ignore */ }
}
const ICO_COPY = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="6.5" y="6.5" width="10" height="10" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M13.5 6.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" stroke="currentColor" stroke-width="1.5"/></svg>`;
const ICO_REVERT = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3.5 8a6.5 6.5 0 1 1-1 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M3.5 3.5V8H8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICO_SPEAK = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3 7.5v5h2.5L10 16V4L5.5 7.5H3z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M13 7.5a4 4 0 0 1 0 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
async function doCopy(btn: HTMLButtonElement) {
  const msg = btn.closest(".msg");
  const clone = msg?.cloneNode(true) as HTMLElement | null;
  clone?.querySelector(".mmenu-wrap")?.remove();
  const text = clone?.textContent?.trim() ?? "";
  const isIcon = btn.classList.contains("act-copy");
  const orig = btn.innerHTML;
  try {
    await navigator.clipboard.writeText(text);
    if (isIcon) {
      btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4 10.5l4 4 7-8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      btn.title = "Copied";
      setTimeout(() => {
        btn.innerHTML = orig;
        btn.title = "Copy";
      }, 1200);
    }
  } catch { /* ignore */ }
}
// ---- changes pane (Claude-style diff sidebar) ----
type DiffRef = { tool: string; path: string; args: any; out: string };
const diffFiles = new Map<string, DiffRef>(); // path -> latest edit/write, this view
let selKey: string | null = null; // selected file in the pane list
let viewRef: DiffRef | null = null; // pinned read, or selected file
function diffKey(tool: string, path: string): string {
  return path && path !== tool ? path : `${tool}:${path}`;
}
function trackDiff(ref: DiffRef) {
  const k = diffKey(ref.tool, ref.path);
  diffFiles.set(k, ref);
  selKey = k;
  viewRef = ref;
}
function collectEdits(arr: any[], calls: Map<string, any>) {
  diffFiles.clear();
  selKey = null;
  viewRef = null;
  for (const m of arr) {
    if (m?.role !== "toolResult") continue;
    const tn = (m.toolName ?? "").toLowerCase();
    if (tn !== "edit" && tn !== "write") continue;
    const a = calls.get(m.toolCallId);
    const p = a?.arguments?.path ?? tn;
    trackDiff({ tool: m.toolName, path: p, args: a?.arguments ?? {}, out: textOf(m.content) });
  }
}
// Live tool result: edits/writes join the file list, reads pin view-only.
// Reads never touch the pane: only file changes (edit/write) appear there.
// Everything else expands inline in the transcript and leaves it alone.
function noteDiff(ref: DiffRef) {
  const tn = (ref.tool || "").toLowerCase();
  if (tn !== "edit" && tn !== "write") return;
  trackDiff(ref);
  if (!$("diffpane").classList.contains("hidden")) renderDiffPane();
}
function refCounts(r: DiffRef): string {
  const t = (r.tool || "").toLowerCase();
  if (t === "edit") return editCounts(r.args);
  if (t === "write" && typeof r.args?.content === "string") return `+${r.args.content.split("\n").length}`;
  return "";
}
// Code block with line numbers (reads in the Changes pane).
function codeLines(src: string): HTMLElement {
  const box = el("div", "codelines");
  for (const ln of src.split("\n").slice(0, 400)) {
    box.appendChild(el("div", "cl", esc(ln || " ")));
  }
  return box;
}
function renderDiffBody(ref: DiffRef): HTMLElement {
  const t = (ref.tool || "").toLowerCase();
  const content = typeof ref.args?.content === "string" ? ref.args.content : "";
  // Markdown files read better rendered than as a green wall of raw text.
  if (t === "write" && content && /\.(md|markdown|mdx)$/i.test(ref.path)) {
    // Rendered documents need no card frame — text on pane background.
    return el("div", "mdpreview", renderMd(content.slice(0, 12000)));
  }
  if (t === "edit" || t === "write") {
    const d = editDiff(ref.tool, ref.args);
    if (d) {
      // Pane title already names the file; drop the duplicate inner header.
      d.querySelector(":scope > .diffhead")?.remove();
      return d;
    }
  }
  if (t === "read") {
    const wrap = el("div", "diffblock");
    wrap.appendChild(el("div", "diffhead", `${esc(ref.path)} · read-only`));
    const txt = ref.out.length > 6000 ? ref.out.slice(0, 6000) + "\n…(truncated)" : ref.out;
    wrap.appendChild(codeLines(txt));
    return wrap;
  }
  const wrap = el("div", "diffblock");
  wrap.appendChild(el("div", "diffhead", esc(ref.path)));
  wrap.appendChild(el("div", "tgout", renderMd(ref.out.slice(0, 4000))));
  return wrap;
}
function renderDiffPane() {
  const body = $("diffbody");
  const title = $("difftitle");
  body.innerHTML = "";
  if (diffFiles.size) {
    const list = el("div", "filelist");
    for (const [k, r] of diffFiles) {
      const base = r.path.split("/").pop() || r.path;
      const o = el("button", "fileopt" + (k === selKey ? " cur" : ""),
        `<span class="fname">${esc(base)}</span><span class="fcount">${esc(refCounts(r))}</span>`) as HTMLButtonElement;
      o.title = r.path;
      o.addEventListener("click", () => {
        selKey = k;
        viewRef = r;
        renderDiffPane();
      });
      list.appendChild(o);
    }
    body.appendChild(list);
  }
  if (!viewRef) {
    title.textContent = "Changes";
    if (!diffFiles.size) body.appendChild(el("div", "msg sys", "No changes to show"));
    return;
  }
  title.textContent = viewRef.path.split("/").pop() || viewRef.path;
  body.appendChild(renderDiffBody(viewRef));
  wireCopy(body);
}
// Single owner of pane visibility: hidden flag, wide-feed layout flag and
// header-button state always move together, so they can't get stuck apart.
function setDiffPane(open: boolean) {
  $("diffpane").classList.toggle("hidden", !open);
  ($("diffbtn") as HTMLButtonElement).classList.toggle("open", open);
  if (open) renderDiffPane();
}
const toolElapsed = new Map<string, number>(); // toolCallId -> durationMs (server-reported)
let runT0 = 0;
let runTok = 0;
let lastRun: HTMLElement | null = null;
function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}
// Claude-style one-line tool summary from name + args.
function toolSummary(name: string, p: any): string {
  const s = (v: any) => (typeof v === "string" ? v : "");
  switch ((name || "").toLowerCase()) {
    case "read": return p?.path ? `Read ${s(p.path)}` : "Read";
    case "edit": {
      const c = editCounts(p);
      return p?.path ? `Edit ${s(p.path)}${c ? ` ${c}` : ""}` : "Edit";
    }
    case "write": {
      const n = typeof p?.content === "string" ? p.content.split("\n").length : 0;
      return p?.path ? `Write ${s(p.path)}${n ? ` (+${n})` : ""}` : "Write";
    }
    case "bash": return s(p?.command) ? `$ ${s(p.command).slice(0, 80)}` : "Bash";
    case "glob": return s(p?.pattern) ? `Glob ${s(p.pattern)}` : "Glob";
    case "grep": return s(p?.pattern) ? `Grep ${s(p.pattern)}` : "Grep";
    default: {
      const first = p && typeof p === "object" ? s(p.path || p.command || p.pattern || p.url || p.query) : "";
      return first ? `${name} ${first.slice(0, 60)}` : name;
    }
  }
}
function editCounts(p: any): string {
  try {
    let add = 0, del = 0;
    for (const e of p?.edits ?? []) {
      add += String(e?.newText ?? "").split("\n").length;
      del += String(e?.oldText ?? "").split("\n").length;
    }
    if (!add && !del) return "";
    return `+${add} −${del}`;
  } catch { return ""; }
}
// Unified diff block computed from edit/write args (the results carry no diff).
function editDiff(name: string, p: any): HTMLElement | null {
  try {
    const n = (name || "").toLowerCase();
    if (n === "edit" && Array.isArray(p?.edits) && p.edits.length) {
      const wrap = el("div", "diffblock");
      wrap.appendChild(el("div", "diffhead", esc(p.path ?? "edit")));
      for (const e of p.edits.slice(0, 5)) {
        wrap.appendChild(lineDiffBlock(String(e?.oldText ?? ""), String(e?.newText ?? "")));
      }
      return wrap;
    }
    // A new file is a diff with an empty old side: same hunks, gutters
    // and colors as edits, every line an addition. No separate look.
    if (n === "write" && typeof p?.content === "string") {
      const wrap = el("div", "diffblock");
      wrap.appendChild(el("div", "diffhead", esc(p.path ?? "write")));
      const box = el("div", "dlblock");
      for (const t of p.content.slice(0, 4000).split("\n").slice(0, 400)) {
        box.appendChild(el("div", "dlline dl-add", `<span class="dlgutter">+</span><code>${esc(t) || " "}</code>`));
      }
      wrap.appendChild(box);
      return wrap;
    }
  } catch { /* fall through */ }
  return null;
}
function lineDiffBlock(oldS: string, newS: string): HTMLElement {
  const a = oldS.split("\n"), b = newS.split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const box = el("div", "dlblock");
  const line = (cls: string, sig: string, t: string) => {
    box.appendChild(el("div", "dlline " + cls, `<span class="dlgutter">${sig}</span><code>${esc(t) || " "}</code>`));
  };
  a.slice(Math.max(0, pre - 2), pre).forEach((t) => line("dl-ctx", " ", t));
  a.slice(pre, a.length - suf).forEach((t) => line("dl-del", "−", t));
  b.slice(pre, b.length - suf).forEach((t) => line("dl-add", "+", t));
  b.slice(b.length - suf, b.length - suf + 2).forEach((t) => line("dl-ctx", " ", t));
  if (!a.length && !b.length) line("", " ", "(empty)");
  return box;
}

// One toolbar per user turn, at the end of that turn's whole agent reply
// (all interim texts + tool rows + final text share it). User bubbles keep
// their own hover toolbar; these rows cover agent replies.
function agentToolsRow(): HTMLElement {
  return el("div", "turn-tools",
    `<button class="act-tcopy iconbtn" title="Copy reply">${ICO_COPY}</button>` +
    `<button class="act-tspeak iconbtn" title="Read aloud">${ICO_SPEAK}</button>`);
}
// All assistant-bubble texts of the turn containing `row` (oldest first).
// The row lives inside the turn's last bubble; walk back to the user bubble.
function turnText(row: HTMLElement): string {
  const parts: string[] = [];
  const nodes: HTMLElement[] = [];
  let n: Element | null = row.closest(".msg.assistant");
  while (n && !(n as HTMLElement).classList?.contains("umsgwrap")) {
    nodes.unshift(n as HTMLElement);
    n = n.previousElementSibling;
  }
  for (const el of nodes) {
    if (el.classList.contains("msg") && el.classList.contains("assistant")) {
      const c = el.cloneNode(true) as HTMLElement;
      c.querySelector(".turn-tools")?.remove();
      const t = c.textContent?.trim();
      if (t) parts.push(t);
    }
  }
  return parts.join("\n\n");
}
function copyTurn(btn: HTMLButtonElement) {
  const row = btn.closest(".turn-tools") as HTMLElement | null;
  if (!row) return;
  navigator.clipboard.writeText(turnText(row)).catch(() => {});
}
let speakingTurn: HTMLElement | null = null;
function speakTurn(btn: HTMLButtonElement) {
  try {
    const row = btn.closest(".turn-tools") as HTMLElement | null;
    if (speakingTurn === btn || !row) {
      speechSynthesis.cancel();
      speakingTurn = null;
      return;
    }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(turnText(row).slice(0, 2000));
    u.onend = () => (speakingTurn = null);
    speakingTurn = btn;
    speechSynthesis.speak(u);
  } catch { /* no TTS in this WebView */ }
}
function markTurnActions() {
  // Rows live INSIDE the turn's last assistant bubble (not as direct
  // #msgs children), so cleanup must be a descendant selector — the old
  // `#msgs > .turn-tools` never matched and rows duplicated on every
  // message_end/finish/refresh. One row per user turn, rebuilt each call.
  document.querySelectorAll("#msgs .turn-tools").forEach((n) => n.remove());
  if (streaming) return;
  const kids = Array.from(document.querySelectorAll("#msgs > *")) as HTMLElement[];
  let hasAsst = false;
  let lastIdx = -1;
  let segStart = 0;
  const flush = () => {
    // Row goes inside the turn's last assistant bubble so it hover-reveals
    // with that bubble (Claude-style: invisible at rest).
    if (hasAsst) {
      for (let i = lastIdx; i >= segStart; i--) {
        const k = kids[i];
        if (k.classList?.contains("msg") && k.classList.contains("assistant") && !k.classList.contains("stream")) {
          k.appendChild(agentToolsRow());
          break;
        }
      }
    }
    hasAsst = false;
    lastIdx = -1;
  };
  kids.forEach((k, i) => {
    if (k.classList.contains("umsgwrap")) {
      flush();
      segStart = i + 1;
      return;
    }
    lastIdx = i;
    if (k.classList.contains("msg") && k.classList.contains("assistant")) hasAsst = true;
  });
  flush();
}

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
    // Hover toolbar, icon-only and hidden at rest (Claude-style): copy +
    // revert. Overlay takes no layout space so the bubble hugs the text.
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
    // No toolbar here: markFinalActions() puts one only under the final
    // agent message. Revert lives on user messages (pi forks at the user
    // turn; Claude's Rewind equivalent).
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
    const params = args?.arguments ?? {};
    const ok = !m.isError;
    const elapsed = toolElapsed.get(m.toolCallId ?? "");
    const d = el("details", "toolrow");
    d.appendChild(el("summary", "tgsum",
      `<span class="tstat ${ok ? "ok" : "err"}">${ok ? "✓" : "✗"}</span> ` +
      esc(toolSummary(m.toolName ?? "tool", params)) +
      (elapsed != null ? ` <span class="telapsed">· ${fmtMs(elapsed)}</span>` : "")));
    const diff = editDiff(m.toolName ?? "", params);
    if (diff) {
      d.appendChild(diff);
    } else {
      const ran = args?.arguments ? esc(JSON.stringify(args.arguments)).slice(0, 500) : "";
      const out = textOf(m.content).slice(0, 2000);
      if (ran) d.appendChild(el("div", "tgrun", `<code>${ran}</code>`));
      if (out) d.appendChild(el("div", "tgout", renderMd(out)));
    }
    (d as any)._diff = { tool: m.toolName ?? "tool", path: params.path ?? (m.toolName ?? "tool"), args: params, out: textOf(m.content) };
    wireCopy(d);
    return d;
  }
  if (role === "bashExecution") {
    const d = el("details", "toolrow");
    d.appendChild(el("summary", "tgsum", `<span class="tstat ok">✓</span> $ ${esc((m.command ?? "bash").slice(0, 80))}`));
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
    pin();
  } else {
    streamDiv.remove();
  }
  streamDiv = null;
  streamBuf = "";
}

// Thinking indicator lives in the message flow, where the answer will
// stream — never parked in a separate row above the composer.
// dotsToEnd: content appended after the dots would strand them mid-flow
// (stream text, tool rows, late messages). Re-pin them last on every
// append so they always sit under the newest content.
function dotsToEnd(): void {
  const d = $("runstatus");
  if (d) $("msgs").appendChild(d);
}
function showThinking() {
  if (refreshActive) return; // rebuild owns the tree; dots re-arm after
  hideThinking();
  const d = el("div", "msg thinking-row", THINKING_DOTS);
  d.id = "runstatus";
  $("msgs").appendChild(d);
  pin();
}
function hideThinking() {
  $("runstatus")?.remove();
}

function route(rec: any) {
  if (!rec) return;
  // Streaming deltas (wire records are delta-only).
  if (rec.type === "message_update") {
    if (rec.usage && typeof rec.usage.totalTokens === "number") {
      runTok = Math.max(runTok, rec.usage.totalTokens);
    }
    const ev = rec.assistantMessageEvent ?? {};
    if (ev.type === "text_delta" && typeof ev.delta === "string") {      // Dots stay until the final answer (agent_settled), even while text
      // streams or tools run in gaps. No flicker clearing anywhere else.
      // First token takes the indicator's place in the flow.
      if (streamBuf === "") hideThinking();
      awaitingResponse = false; // agent output: bridge no longer needed
      streamBuf += ev.delta;
      // A history rebuild owns the tree while active: accumulate only.
      // Wiring/DOM resumes on later deltas once the rebuild lands.
      if (refreshActive) return;
      if (!streamDiv) {
        streamDiv = el("div", "msg assistant stream");
        $("msgs").appendChild(streamDiv);
      }
      streamDiv.innerHTML = renderMd(streamBuf);
      // Throttled mid-stream wiring: local images/cards resolve while the
      // answer is still coming. Resolve-once cache keeps this to one
      // backend read per path; guards skip already-wired elements, and
      // resolved bytes inline synchronously on the next token (no flicker).
      const now = Date.now();
      if (now - lastStreamWire > 1500) {
        lastStreamWire = now;
        wireCopy(streamDiv);
      }
      dotsToEnd();
      pin();
    } else if (ev.type === "toolcall_start") {
      showThinking();
    } else if (typeof ev.type === "string" && ev.type.includes("think")) {
      if (refreshActive) return; // partial thinks; full blocks via history
      awaitingResponse = false;
      const d = (ev as any).delta ?? (ev as any).text ?? "";
      if (typeof d === "string" && d) {
        if (!liveThinkDiv) {
          liveRun = runAppend($("msgs"), liveRun, thoughtDiv(""));
          liveThinkDiv = (liveRun as HTMLElement).querySelector(".tgbody > .runthought:last-child");
          liveThinkBuf = "";
        }
        liveThinkBuf += d;
        if (liveThinkDiv) liveThinkDiv.innerHTML = renderMd(liveThinkBuf.slice(-4000));
        dotsToEnd();
      }
    }
    return;
  }
  // Authoritative completed message (top-level per json.md).
  if (rec.type === "message_end" && rec.message) {
    if (rec.message.role === "assistant" || rec.message.role === "toolResult" || rec.message.role === "bashExecution") {
      awaitingResponse = false;
    }
    flushStream(rec.message.role === "assistant" ? textOf(rec.message.content) : undefined);
    if (rec.message.role === "system") return;
    // History rebuild owns the tree while active: keep bookkeeping maps
    // warm (tool args, final-text dedup) but write no DOM — history covers
    // it, and a second copy is exactly the back-to-back duplication.
    if (refreshActive) {
      if (rec.message.role === "assistant" && Array.isArray(rec.message.content)) {
        for (const b of rec.message.content) {
          if (b && b.type === "toolCall" && b.id) liveCalls.set(b.id, b);
        }
      }
      return;
    }
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
      // Mirror: pi echoes user messages at delivery time, in true order.
      // Always render the echo — no optimistic bubbles, no skip tokens,
      // so the transcript can never disagree with pi's own history.
      liveRun = null;
    }
    if (rec.message.role === "assistant" && Array.isArray(rec.message.content)) {
      for (const b of rec.message.content) {
        if (b && b.type === "thinking" && b.thinking) {
          liveRun = runAppend($("msgs"), liveRun, thoughtDiv(b.thinking));
          dotsToEnd();
        }
      }
    }
    if (rec.message.role === "toolResult" || rec.message.role === "bashExecution") {
      liveRun = runAppend($("msgs"), liveRun, msgNode(rec.message, liveCalls));
      dotsToEnd();
      pin();
      if (rec.message.role === "toolResult") {
        const tn = (rec.message.toolName ?? "").toLowerCase();
        // Pane tracks file changes only (edit/write). Reads, bash and
        // friends expand inline and never touch it.
        if (tn === "edit" || tn === "write") {
          const a = liveCalls.get(rec.message.toolCallId);
          noteDiff({ tool: rec.message.toolName, path: a?.arguments?.path ?? tn, args: a?.arguments ?? {}, out: textOf(rec.message.content) });
        }
      }
      return;
    }
    if (rec.message.role === "assistant" && !textOf(rec.message.content)) return;
    // Mirror: every assistant text renders, even exact repeats. pi shows
    // them; suppressing was our invention (streaming made benign dupes,
    // but the transcript must never disagree with pi's history).
    const n = msgNode(rec.message, liveCalls);
    $("msgs").appendChild(n);
    wireCopy(n);
    dotsToEnd();
    pin();
    // Live text splits the Activity stream like history does: later
    // thoughts/tools start a new container below this bubble. Clear the
    // partial-think pointer too, or new deltas bleed into the old box.
    if (rec.message.role === "assistant") {
      liveRun = null;
      liveThinkDiv = null;
      liveThinkBuf = "";
    }
    markTurnActions();
    return;
  }
  if (rec.type === "tool_execution_start") {
    showThinking();
    return;
  }
  if (rec.type === "tool_execution_end") {
    if (rec && typeof rec.toolCallId === "string" && typeof rec.durationMs === "number") {
      toolElapsed.set(rec.toolCallId, rec.durationMs);
    }
    return;
  }
  if (rec.type === "agent_settled") {
    finishRun();
    return;
  }
  // Mirror of pi's queue: authoritative {steering[], followUp[]} snapshot.
  // Already key-filtered to the viewed session upstream. Renders the
  // queued bar (edit / promote-to-steer live here now, not on bubbles).
  if (rec.type === "queue_update") {
    lastQueue = {
      steering: Array.isArray(rec.steering) ? rec.steering.filter((s: any) => typeof s === "string") : [],
      followUp: Array.isArray(rec.followUp) ? rec.followUp.filter((s: any) => typeof s === "string") : [],
    };
    renderQueued();
    return;
  }
}

const THINKING_DOTS = `<span class="thinking" aria-label="thinking"><i></i><i></i><i></i></span>`;

function startRun() {
  streaming = true;
  streamBuf = "";
  markTurnActions();
  runT0 = Date.now();
  runTok = 0;
  syncSendBtn();
  showThinking();
}

const autoNamed = new Set<string>();

// ChatGPT auto-titles chats: name an unnamed session from its first prompt.
// (Deliberate divergence from pi defaults — pi's generated names are ids.)
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

// Truth-based run watchdog: while the UI believes a run is live, poll the
// agent's own isStreaming flag. Settles the UI when the agent is actually
// done (normal path is still agent_settled; this covers lost events and
// dead children). Never settles while the agent reports work in progress,
// no matter how long the run takes. 30min cap so a wedged poller dies.
function watchRun(watchCwd: string): void {
  let n = 0;
  const t = setInterval(async () => {
    if (!streaming || watchCwd !== cwd) {
      clearInterval(t);
      return;
    }
    if (++n > 120) {
      finishRun();
      clearInterval(t);
      return;
    }
    try {
      const s: any = await pi.state(watchCwd);
      if (s && s.isStreaming === false) {
        finishRun();
        clearInterval(t);
      }
    } catch {
      /* pi busy/starting: keep watching */
    }
  }, 15_000);
}

// settled=true only when the agent genuinely finished (agent_settled
// event, or watchdog-observed idle). Send-failure and cap paths pass
// false and never auto-send: firing into a dead/busy backend loops errors.
function finishRun() {
  streaming = false;
  clearMediaCache(); // regenerated files must re-read next run
  streaming = false;
  clearMediaCache(); // regenerated files must re-read next run
  if (streamDiv && streamBuf) {
    // No message_end arrived: flush what we streamed.
    const n = el("div", "msg assistant", renderMd(streamBuf));
    streamDiv.replaceWith(n);
    wireCopy(n);
  }
  streamDiv = null;
  streamBuf = "";
  syncSendBtn();
  hideThinking();
  // Follow-up bridge: turn A settled with our message accepted but turn
  // B silent so far — stay visibly working instead of dead idle. Any
  // agent output, abort, or 90s clears it; first token hides dots anyway.
  if (awaitingResponse) {
    awaitingResponse = false;
    showThinking();
    setTimeout(() => {
      if (!streaming) hideThinking();
    }, 90_000);
  }
  pin();
  markTurnActions();
  if (lastRun && runT0 > 0) {
    const sum = lastRun.querySelector(":scope > summary");
    if (sum) {
      const secs = ((Date.now() - runT0) / 1000).toFixed(1);
      sum.innerHTML = `Activity · ${secs}s${runTok ? ` · ${fmtTok(runTok)} tokens` : ""} ${CHEV}`;
    }
    lastRun = null;
  }
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
    lastRun = run;
    run.appendChild(el("div", "tgbody"));
    box.appendChild(run);
  }
  run.querySelector(".tgbody")!.appendChild(item);
  return run;
}

function thoughtDiv(text: string): HTMLElement {
  if (!text.trim()) return el("div", "runthought dim", "Thought");
  return el("div", "runthought", renderMd(text.slice(0, 4000)));
}

const CHEV = `<svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

// True while a history rebuild owns #msgs. Live event appends during the
// load window would duplicate history (same message rendered live AND from
// the load) and strand the thinking dots mid-flow — route() skips DOM
// writes while set (bookkeeping maps still update).
let refreshActive = false;

async function refreshMsgs() {
  const box = $("msgs");
  box.innerHTML = "";
  // Authoritative wipe: drop live partials too (stream preview, partial
  // Activity, half-streamed thought). Post-wipe deltas rebuild cleanly;
  // without this they write into a detached tree and vanish.
  streamDiv = null;
  streamBuf = "";
  liveRun = null;
  liveThinkDiv = null;
  liveThinkBuf = "";
  hideThinking();
  refreshActive = true;
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
    const isTool = (m: any) => m.role === "toolResult" || m.role === "bashExecution";
    for (const m of arr) {
      if (m.role === "system") continue;
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
      // Mirror: repeats render. (Dedup was ours; pi shows them.)
      const fid = m.role === "user" ? takeForkId(textOf(m.content)) : undefined;
      const n = msgNode(m, calls, fid);
      box.appendChild(n);
      // Rendered text splits the Activity stream: thoughts/tools after
      // this bubble belong to a NEW container below it, not clumped
      // into the one above. (User messages already reset; textless
      // assistant turns continued out earlier.)
      if (m.role === "assistant") run = null;
      shown++;
    }
    collectEdits(arr, calls);
    if (!$("diffpane").classList.contains("hidden")) renderDiffPane();
    if (!shown) {
      const g = el("div", "greet", `<h2>Ready when you are.</h2>`);
      box.appendChild(g);
    }
    wireCopy(box);
    markTurnActions();
    const mp = $("scrollwrap");
    mp.scrollTop = mp.scrollHeight;
    refreshActive = false;
  } catch (e: any) {
    refreshActive = false;
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
  syncSendBtn();
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

// Async: history load is awaited so late arrivers (thinking dots) can
// never land before the transcript they belong under. Callers that don't
// care may ignore the promise.
async function refreshAll(withModels: boolean): Promise<void> {
  refreshSessions();
  await refreshMsgs();
  if (withModels) await refreshModels();
  else await refreshState();
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
  clearMediaCache();
  streamDiv?.remove();
  streamDiv = null;
  streamBuf = "";
  liveRun = null;
  liveThinkDiv = null;
  liveThinkBuf = "";
  lastQueue = null;
  $("qbar")?.replaceChildren();
  lastRun = null;
  diffFiles.clear();
  selKey = null;
  viewRef = null;
  if (!$("diffpane").classList.contains("hidden")) renderDiffPane();
  syncSendBtn();
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
  // Relative embeds (./shots/…) resolve against the viewed session's own
  // cwd, which may differ from the window cwd after cross-dir navigation.
  const info = sessCache.find((x) => x.path === path);
  if (info?.cwd) setMediaBase(info.cwd);
  try {
    resetRunState();
    await ensure(cwd, path, path);
    setKey(path);
    viewKey = path;
    viewPath = path;
    curFile = path;
  } catch (e: any) {
    alert(`switch failed: ${e.message ?? e}`);
    return;
  }
  refreshAll(false);
  // AFTER the rebuild: refreshMsgs wipes #msgs (including any thinking
  // row), so re-arming here is the only order that survives. Returning
  // to a still-running session shows its thinking indicator again.
  await syncRunFlag();
}

// If the session we just opened is still running server-side, reflect it
// locally so the composer locks and completion settles normally.
async function syncRunFlag() {
  try {
    const s: any = await pi.state(cwd);
    if (s?.isStreaming) {
      streaming = true;
      syncSendBtn();
      showThinking();
    }
    // Count-only queue fallback: texts arrive via queue_update, but a
    // background queue predates our view of the session. Never invent
    // texts — show the count until an event refines it (or zero clears).
    if (typeof s?.pendingMessageCount === "number") {
      if (s.pendingMessageCount > 0 && !lastQueue) {
        lastQueue = { steering: [], followUp: [] };
        const bar = $("qbar");
        bar.innerHTML = "";
        bar.appendChild(el("div", "qit", `<span class="qbadge">queue</span><span class="qtxt">${s.pendingMessageCount} message(s) queued with the agent…</span>`));
      } else if (s.pendingMessageCount === 0 && lastQueue && !lastQueue.steering.length && !lastQueue.followUp.length) {
        lastQueue = null;
        $("qbar")?.replaceChildren();
      }
    }
  } catch { /* ignore */ }
}

async function send() {
  const inp = $("input") as HTMLTextAreaElement;
  const text = inp.value.trim();
  if (!text) {
    // Empty fire while streaming still means stop (the button's job).
    if (streaming) stopOnly();
    return;
  }
  // Mid-run text transmits as followUp without disturbing the run.
  // No optimistic bubble: pi echoes at delivery time, in true order —
  // the echo IS the render (mirroring the harness, never our own guess).
  if (streaming) {
    await sendFollowUp(text);
    return;
  }
  stick = true;
  // Transmit-only: the bubble appears when pi echoes (milliseconds when
  // idle). startRun's dots are the send acknowledgment. On failure the
  // text goes back to the composer instead of being lost.
  inp.value = "";
  syncSendBtn();
  inp.style.height = "auto";
  $("msgs").querySelector(".greet")?.remove();
  liveRun = null;
  liveThinkDiv = null;
  liveThinkBuf = "";
  liveCalls = new Map<string, any>();
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
    // Completion arrives via agent_settled. Watchdog (not a fixed timer):
    // the old 180s safety net declared the run finished while long agents
    // were still working. Now we poll the agent's own isStreaming flag and
    // only settle the UI when it is actually done (or lost, or 30min cap).
    watchRun(cwd);
  } catch (e: any) {
    $("msgs").appendChild(el("div", "msg sys", esc(`send failed (kept in composer): ${e.message ?? e}`)));
    const inp2 = $("input") as HTMLTextAreaElement;
    inp2.value = text;
    syncSendBtn();
    finishRun();
  }
  persistLastCwd();
}

// Mirror of pi's send path: transmit only, never render. The bubble appears
// when pi echoes (message_end role=user) — at delivery, in true order.
// Mid-run the echo lands when the message is accepted; idle, within ms.
// Failures restore the text to the composer instead of losing it.
async function sendFollowUp(text: string): Promise<void> {
  const inp = $("input") as HTMLTextAreaElement;
  inp.value = "";
  syncSendBtn();
  inp.style.height = "auto";
  stick = true;
  try {
    await ensure(cwd, viewKey || undefined, viewPath);
    if (viewKey) setKey(viewKey);
  } catch (e: any) {
    $("msgs").appendChild(el("div", "msg sys", esc(`pi failed to start: ${e.message ?? e}`)));
    inp.value = text;
    syncSendBtn();
    return;
  }
  try {
    await pi.prompt(cwd, text, "followUp");
    awaitingResponse = true;
  } catch (e: any) {
    $("msgs").appendChild(el("div", "msg sys", esc(`follow-up failed, kept in composer (run continues): ${e.message ?? e}`)));
    inp.value = text;
    syncSendBtn();
  }
  persistLastCwd();
}

// Mirror of pi's queue: renders the authoritative queue_update snapshot
// ({steering[], followUp[]}) as a slim bar above the composer. Edit and
// promote-to-steer live here — on pi's data, not on guessed bubbles.
// clear_queue returns the held texts, so edit/promote never lose content:
// the target goes where asked, the rest are silently re-queued in order.
function renderQueued(): void {
  const bar = $("qbar");
  bar.innerHTML = "";
  const q = lastQueue;
  if (!q || (!q.steering.length && !q.followUp.length)) return;
  const items: Array<{ text: string; kind: "steer" | "followUp" }> = [
    ...q.steering.map((text) => ({ text, kind: "steer" as const })),
    ...q.followUp.map((text) => ({ text, kind: "followUp" as const })),
  ];
  for (const it of items) {
    const row = el("div", "qit");
    const badge = el("span", "qbadge" + (it.kind === "steer" ? " steer" : ""),
      esc(it.kind === "steer" ? "steer" : "follow-up"));
    const txt = el("span", "qtxt", esc(it.text));
    txt.title = it.text;
    const edit = el("button", "qedit", "edit") as HTMLButtonElement;
    edit.title = "Edit queued message";
    edit.addEventListener("click", () => editQueued(it.text, it.kind));
    row.appendChild(badge);
    row.appendChild(txt);
    row.appendChild(edit);
    if (it.kind === "followUp") {
      const promote = el("button", "qpromote", "steer") as HTMLButtonElement;
      promote.title = "Promote to steer (redirects the live run)";
      promote.addEventListener("click", () => promoteQueued(it.text));
      row.appendChild(promote);
    }
    bar.appendChild(row);
  }
}

// Edit a queued message, mirroring pi's own abort flow: clear the queue,
// restore the target to the composer, re-queue everything else untouched.
async function editQueued(text: string, kind: "steer" | "followUp"): Promise<void> {
  let q: { steering: string[]; followUp: string[] };
  try {
    q = await pi.clearQueue(cwd);
  } catch (e: any) {
    $("msgs").appendChild(el("div", "msg sys", esc(`queue edit failed: ${e.message ?? e}`)));
    return;
  }
  lastQueue = { steering: [], followUp: [] };
  renderQueued();
  const dropOnce = (arr: string[]): string[] => {
    const i = arr.indexOf(text);
    if (i < 0) return arr;
    return [...arr.slice(0, i), ...arr.slice(i + 1)];
  };
  const reSteer = kind === "steer" ? dropOnce(q.steering) : q.steering;
  const reFollow = kind === "followUp" ? dropOnce(q.followUp) : q.followUp;
  const inp = $("input") as HTMLTextAreaElement;
  inp.value = text;
  inp.style.height = "auto";
  inp.style.height = Math.min(inp.scrollHeight, 200) + "px";
  syncSendBtn();
  inp.focus();
  for (const s of reSteer) {
    try {
      await pi.steerMsg(cwd, s);
    } catch { /* backend busy: text stays only in composer then */ }
  }
  for (const f of reFollow) {
    try {
      await pi.followUpMsg(cwd, f);
    } catch { /* ignore */ }
  }
}

// Promote a queued follow-up to steer: same clear + re-queue, but the
// target goes back via steer so it jumps ahead of the next model call.
// (pi has no in-place promote; clear + resubmit is its own documented
// shape for queue surgery.)
async function promoteQueued(text: string): Promise<void> {
  let q: { steering: string[]; followUp: string[] };
  try {
    q = await pi.clearQueue(cwd);
  } catch (e: any) {
    $("msgs").appendChild(el("div", "msg sys", esc(`steer failed: ${e.message ?? e}`)));
    return;
  }
  lastQueue = { steering: [], followUp: [] };
  renderQueued();
  const rest = q.followUp.filter((f) => f !== text);
  try {
    await pi.steerMsg(cwd, text);
  } catch (e: any) {
    $("msgs").appendChild(el("div", "msg sys", esc(`steer failed: ${e.message ?? e}`)));
    const inp = $("input") as HTMLTextAreaElement;
    inp.value = text;
    syncSendBtn();
  }
  for (const f of rest) {
    try {
      await pi.followUpMsg(cwd, f);
    } catch { /* ignore */ }
  }
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
  setMediaBase(next);
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
  await refreshAll(true);
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

  // Hover toolbars: copy message text, speak it, or revert (fork) at a user
  // message. Queued-message edit/steer live on the queue bar (pi's data),
  // not on bubbles. Sending after a revert forks a branch (shows
  // "No summary" in pi's tree view until pi summarizes the abandoned
  // branch).
  document.addEventListener("click", async (e) => {
    const rv = (e.target as HTMLElement).closest?.(".act-revert") as HTMLButtonElement | null;
    if (rv?.dataset.entry) {
      e.stopPropagation();
      await doRevert(rv.dataset.entry);
      return;
    }
    const tc = (e.target as HTMLElement).closest?.(".act-tcopy") as HTMLButtonElement | null;
    if (tc) {
      e.stopPropagation();
      copyTurn(tc);
      return;
    }
    const ts = (e.target as HTMLElement).closest?.(".act-tspeak") as HTMLButtonElement | null;
    if (ts) {
      e.stopPropagation();
      speakTurn(ts);
      return;
    }
    const b = (e.target as HTMLElement).closest?.(".act-copy") as HTMLButtonElement | null;
    if (!b) return;
    doCopy(b);
  });

window.addEventListener("DOMContentLoaded", async () => {
  setTag("main");
  ($("send") as HTMLButtonElement).addEventListener("click", () => {
    if (streaming) stopOnly();
    else send();
  });
  ($("abortbtn") as HTMLButtonElement).addEventListener("click", () => {
    stopOnly();
  });
  const inp = $("input") as HTMLTextAreaElement;
  const autogrow = () => {
    inp.style.height = "auto";
    inp.style.height = Math.min(inp.scrollHeight, 200) + "px";
  };
  inp.addEventListener("input", () => {
    autogrow();
    syncSendBtn();
  });
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      stopOnly();
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
  const scrollerEl = $("scrollwrap");
  const scroller = () => {
    const away = scrollerEl.scrollHeight - scrollerEl.scrollTop - scrollerEl.clientHeight;
    stick = away < 80;
    ($("scrollbtn") as HTMLButtonElement).classList.toggle("hidden", away < 200);
  };
  scrollerEl.addEventListener("scroll", scroller);
  ($("diffbtn") as HTMLButtonElement).addEventListener("click", () => {
    setDiffPane($("diffpane").classList.contains("hidden"));
  });
  ($("diffclose") as HTMLButtonElement).addEventListener("click", () => {
    setDiffPane(false);
  });
  const rp = $("diffpane");
  const savedW = Number(localStorage.getItem("diffpane-w") || 0);
  if (savedW >= 280 && savedW <= 900) rp.style.flexBasis = savedW + "px";
  ($("diffresize") as HTMLElement).addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = rp.getBoundingClientRect().width;
    const move = (ev: MouseEvent) => {
      rp.style.flexBasis = Math.min(900, Math.max(280, startW + (startX - ev.clientX))) + "px";
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      localStorage.setItem("diffpane-w", String(Math.round(rp.getBoundingClientRect().width)));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
  // Expanding an edit/write row tracks it in the Changes pane (lands
  // there on manual open) — but never force-opens it. Reads, bash and
  // friends expand inline only. (`toggle` doesn't bubble, so listen in
  // capture phase.)
  document.addEventListener("toggle", (e) => {
    const d = e.target as HTMLElement;
    if (d?.tagName === "DETAILS" && d.classList.contains("toolrow") && (d as HTMLDetailsElement).open) {
      const ref = (d as any)._diff as DiffRef | undefined;
      const tn = (ref?.tool || "").toLowerCase();
      if (!ref || (tn !== "edit" && tn !== "write")) return;
      noteDiff(ref);
      selKey = diffKey(ref.tool, ref.path);
      viewRef = diffFiles.get(selKey) ?? ref;
      if (!$("diffpane").classList.contains("hidden")) renderDiffPane();
    }
  }, true);
  ($("scrollbtn") as HTMLButtonElement).addEventListener("click", () => {
    stick = true;
    scrollerEl.scrollTop = scrollerEl.scrollHeight;
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
