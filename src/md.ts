// Tiny markdown renderer: code fences (+copy, +highlight), headings, bold,
// inline code, links, images/video embeds, lists, quotes, paragraphs,
// tables. Pi decides content, this only displays it.
import { invoke } from "./tauri-shim";
//
// Media contract (desktop app concern): the agent figures out *how* to get
// pixels (ffmpeg screenshots, web search, local files) — this module only
// guarantees *rendering*. Supported embeds:
//   ![alt](https://.../pic.png)  -> <img>  (any image ext, or data:image/)
//   ![alt](https://.../clip.mp4) -> playable card opening the system
//     player (see VIDEO_FACADE: inline <video> crashes WebKitGTK where
//     GStreamer is broken, so we never emit a live <video> element).
//   bare https://.../pic.png alone on a line -> auto-embed (same rules)
//   absolute local paths (/home/u/shot.png, file://..., ./rel.png)
//     render as <img data-local> and resolve via Tauri convertFileSrc at
//     wire time (needs setMediaBase(dir) for relative paths).
// Raw <img>/<video> HTML is sanitized down to src+alt+size+playback attrs.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, mod] of Object.entries({ bash, c, cpp, css, diff, go, java, javascript, json, markdown, python, rust, shell, typescript, xml, yaml })) {
  try {
    if (!hljs.getLanguage(name)) hljs.registerLanguage(name, mod as any);
  } catch { /* ignore */ }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- media embeds (images + video) ----

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif",
]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "ogv", "m4v"]);

// Base dir for resolving relative local paths (main.ts sets this on cwd
// switch; without it relative paths resolve against nothing and just fail
// gracefully to a caption + path fallback).
let mediaBase = "";
export function setMediaBase(dir: string): void {
  mediaBase = dir;
}

function extOf(src: string): string {
  const clean = src.split(/[?#]/, 1)[0].split("/").pop() ?? "";
  const dot = clean.lastIndexOf(".");
  if (dot < 0) return "";
  return clean.slice(dot + 1).toLowerCase();
}

// Allowlist: remote https/http, data:image|video, blob/asset/file schemes,
// absolute + relative local paths. Reject scriptable schemes and anything
// with whitespace/control chars or quote/bracket breakouts.
function safeMediaSrc(raw: string): string | null {
  const s = raw.trim();
  if (!s || /[\s<>"\u0000-\u001f]/.test(s)) return null;
  const lower = s.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("vbscript:") ||
    lower.startsWith("data:text/html") ||
    lower.startsWith("data:application")
  )
    return null;
  if (
    lower.startsWith("https://") ||
    lower.startsWith("http://") ||
    lower.startsWith("blob:") ||
    lower.startsWith("asset:") ||
    lower.startsWith("file://") ||
    lower.startsWith("data:image/") ||
    lower.startsWith("data:video/")
  ) {
    return s.length > 15_000_000 ? null : s;
  }
  const scheme = s.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):/);
  // Unknown scheme (ftp:, data:audio, …) — refuse rather than guess.
  if (scheme) return null;
  // Bare local path: /abs, ~/home, ./rel, ../rel, or dir/file.ext.
  return s.length > 2048 ? null : s;
}

function isLocalSrc(src: string): boolean {
  const lower = src.toLowerCase();
  return !(
    lower.startsWith("https://") ||
    lower.startsWith("http://") ||
    lower.startsWith("blob:") ||
    lower.startsWith("asset:") ||
    lower.startsWith("data:")
  );
}

function resolveLocal(src: string): string {
  let p = src;
  if (p.toLowerCase().startsWith("file://")) {
    try {
      p = decodeURI(p.replace(/^file:\/\//, ""));
    } catch {
      p = p.replace(/^file:\/\//, "");
    }
  }
  if (p.startsWith("~/")) return p; // no home expansion frontend-side; try as-is
  if (p.startsWith("/")) return p;
  if (mediaBase && (p.startsWith("./") || p.startsWith("../") || !p.includes(":"))) {
    const base = mediaBase.replace(/\/+$/, "");
    const rel = p.replace(/^\.\//, "");
    // Keep ../ segments: convertFileSrc/the OS sorts them out.
    return `${base}/${rel}`;
  }
  return p;
}

function isVideoSrc(src: string): boolean {
  if (src.toLowerCase().startsWith("data:video/")) return true;
  return VIDEO_EXTS.has(extOf(src));
}

function mediaTag(alt: string, src: string): string {
  const safe = safeMediaSrc(src);
  if (!safe) return `<span>${esc(alt || src)}</span>`;
  const a = esc(alt);
  const u = esc(safe);
  if (isVideoSrc(safe)) return videoFacade(a || esc(fileName(safe)), safe);
  // Local files start with NO src attribute: the raw path is not a valid
  // URL and the browser would fire `error` (→ fallback) before read_media
  // resolves. src is set only once real bytes arrive (see wireMedia).
  // Remote files load directly, src up front.
  if (isLocalSrc(safe)) {
    const cap = a ? `<figcaption>${a}</figcaption>` : "";
    return (
      `<figure class="media"><img loading="lazy" alt="${a}" data-local="${u}">` +
      `${cap}</figure>`
    );
  }
  const cap = a ? `<figcaption>${a}</figcaption>` : "";
  return `<figure class="media"><img loading="lazy" referrerpolicy="no-referrer" src="${u}" alt="${a}">${cap}</figure>`;
}

function fileName(src: string): string {
  try {
    const clean = src.split(/[?#]/, 1)[0].replace(/\/+$/, "");
    const base = clean.split("/").pop() ?? clean;
    return base || src;
  } catch {
    return src;
  }
}

// VIDEO_FACADE: render time never contains a live <video> element — it
// starts life as a click-to-open card. On systems with broken GStreamer
// even one <video> (any preload, even a valid file) SIGABRTs the
// WebKitWebProcess (reproduced in isolation before gst-plugins-good was
// installed: 0 img + 1 video = CRASHED, 12 img + 0 video = alive). The
// pipeline only spins up on explicit user click (playVideoCard), when a
// crash would at worst follow a deliberate gesture instead of a scroll.
function videoFacade(caption: string, src: string, poster: string | null = null): string {
  const u = esc(src);
  const local = isLocalSrc(src) ? ` data-local-path="${u}"` : "";
  const play = `<span class="media-play" aria-hidden="true">\u25B6</span>`;
  // Explicit posters only (`[![cap](frame.jpg)](clip.mp4)`): no filename
  // guessing. Remote posters load directly; local ones resolve async via
  // data-poster-local (see wireMedia) and the slot stays empty meanwhile.
  let thumb = `<span class="media-thumb" aria-hidden="true"></span>`;
  let cls = "media-card";
  if (poster) {
    const p = esc(poster);
    if (isLocalSrc(poster)) {
      thumb = `<span class="media-thumb" aria-hidden="true" data-poster-local="${p}"></span>`;
    } else {
      thumb = `<span class="media-thumb" aria-hidden="true"><img alt="" src="${p}"></span>`;
      cls = "media-card has-poster";
    }
  }
  return (
    `<button class="${cls}" data-open="${u}"${local} title="Play video">` +
    `${thumb}` +
    `${play}<span class="media-name">${caption}</span>` +
    `<span class="media-hint">video \u00B7 click to play</span></button>`
  );
}

// Explicit local posters (`[![cap](./f.jpg)](./c.mp4)`): one read, bytes
// in, thumbnail on. No poster or failed read -> plain card, untouched.
function wireVideoPosters(container: HTMLElement): void {
  container.querySelectorAll<HTMLElement>(".media-thumb[data-poster-local]").forEach((thumb) => {
    if ((thumb as any)._poster) return;
    (thumb as any)._poster = true;
    const raw = thumb.getAttribute("data-poster-local") ?? "";
    const card = thumb.closest("button.media-card");
    if (!raw || !card) return;
    toAssetUrl(resolveLocal(raw)).then((url) => {
      if (!url || !thumb.isConnected) return;
      const img = document.createElement("img");
      img.alt = "";
      img.addEventListener("error", () => {
        img.remove();
        card.classList.remove("has-poster");
      });
      img.src = url;
      thumb.appendChild(img);
      card.classList.add("has-poster");
    });
  });
}

// `[![alt](poster)](target)`: explicit thumbnail syntax (no filename
// coupling). Video target -> poster card; anything else -> linked image.
// Placeholders keep the URLs inside safe from later linkification.
function linkedMedia(alt: string, posterInner: string, targetInner: string): string {
  const posterSrc = firstToken(posterInner);
  const targetSrc = firstToken(targetInner);
  const safePoster = posterSrc ? safeMediaSrc(posterSrc) : null;
  const safeTarget = targetSrc ? safeMediaSrc(targetSrc) : null;
  if (!safeTarget) return esc(`[![${alt}](${posterInner})](${targetInner})`);
  if (isVideoSrc(safeTarget)) {
    const label = esc(alt) || esc(fileName(safeTarget));
    return videoFacade(label, safeTarget, safePoster);
  }
  // Linked image: poster (or alt text if the poster is unusable).
  if (!safePoster) return esc(`[![${alt}](${posterInner})](${targetInner})`);
  const a = esc(alt);
  const t = esc(safeTarget);
  const p = esc(safePoster);
  const img = isLocalSrc(safePoster)
    ? `<img loading="lazy" alt="${a}" data-local="${p}">`
    : `<img loading="lazy" referrerpolicy="no-referrer" src="${p}" alt="${a}">`;
  return `<a href="${t}" target="_blank" rel="noreferrer"><figure class="media">${img}${a ? `<figcaption>${a}</figcaption>` : ""}</figure></a>`;
}

// First whitespace-separated token of a `![alt](...)` inner, unbracketed
// (`<a b.png>`, `"a b.png"`, or bare). Shared with parseImageToken.
function firstToken(inner: string): string {
  let rest = inner.trim();
  if (rest.startsWith("<")) {
    const end = rest.indexOf(">");
    return end < 0 ? "" : rest.slice(1, end);
  }
  const m = rest.match(/^("[^\"]+"|'[^']+'|\S+)/);
  if (!m) return "";
  let src = m[1];
  if ((src.startsWith('"') && src.endsWith('"')) || (src.startsWith("'") && src.endsWith("'"))) {
    src = src.slice(1, -1);
  }
  return src;
}
function parseImageToken(alt: string, inner: string): string {
  let rest = inner.trim();
  let src = "";
  if (rest.startsWith("<")) {
    const end = rest.indexOf(">");
    if (end < 0) return esc(`![${alt}](${inner})`);
    src = rest.slice(1, end);
    rest = rest.slice(end + 1).trim();
  } else {
    const m = rest.match(/^("[^\"]+"|'[^']+'|\S+)/);
    if (!m) return esc(`![${alt}](${inner})`);
    src = m[1];
    rest = rest.slice(m[1].length).trim();
    if ((src.startsWith('"') && src.endsWith('"')) || (src.startsWith("'") && src.endsWith("'"))) {
      src = src.slice(1, -1);
    }
  }
  void rest; // trailing title is accepted and ignored; alt is the caption.
  return mediaTag(alt, src);
}

function attrVal(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>"']+))`, "i"));
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? null;
}

// Sanitize one raw <img ...> tag down to src/alt/width/height. Null = drop.
function sanitizeImg(tag: string): string | null {
  const raw = attrVal(tag, "src");
  if (!raw) return null;
  const safe = safeMediaSrc(raw);
  if (!safe) return null;
  const alt = esc(attrVal(tag, "alt") ?? "");
  const dim = (n: string): string => {
    const v = attrVal(tag, n);
    return v && /^\d{1,4}$/.test(v) ? ` ${n}="${v}"` : "";
  };
  const u = esc(safe);
  // No src up front for local files (see mediaTag: raw paths would error
  // before bytes arrive). Remote keeps src for direct loading.
  const srcAttr = isLocalSrc(safe)
    ? ` data-local="${u}"`
    : ` src="${u}"`;
  return `<figure class="media"><img loading="lazy" referrerpolicy="no-referrer"${srcAttr} alt="${alt}"${dim("width")}${dim("height")}>${alt ? `<figcaption>${alt}</figcaption>` : ""}</figure>`;
}

// Sanitize one raw <video ...>...</video> (or self-closing) tag into a
// click-to-open card (never a live <video>: see VIDEO_FACADE). Null = drop.
function sanitizeVideo(full: string): string | null {
  const open = full.match(/^<video\b[^>]*>/i)?.[0] ?? "";
  const raw = attrVal(open || full, "src") ?? attrVal(full, "src");
  // <source> children: keep the first safe one as the video src.
  let src: string | null = raw ? safeMediaSrc(raw) : null;
  if (!src) {
    const sm = full.match(/<source\b[^>]*>/i)?.[0];
    const sraw = sm ? attrVal(sm, "src") : null;
    src = sraw ? safeMediaSrc(sraw) : null;
  }
  if (!src) return null;
  const label = esc(attrVal(open || full, "title") ?? fileName(src));
  return videoFacade(label, src);
}

function inline(s: string): string {
  // Raw <img>/<video> HTML is sanitized to placeholders BEFORE escaping so
  // legitimate embeds survive esc() while everything else stays escaped.
  const mediaHolders: string[] = [];
  let t = s
    .replace(/<video\b[^>]*>[\s\S]*?<\/video\s*>/gi, (m) => {
      const ok = sanitizeVideo(m);
      if (!ok) return m; // leave for esc(); renders as harmless text
      mediaHolders.push(ok);
      return `\u0005${mediaHolders.length - 1}\u0006`;
    })
    .replace(/<video\b[^>]*\/?>/gi, (m) => {
      const ok = sanitizeVideo(m);
      if (!ok) return m;
      mediaHolders.push(ok);
      return `\u0005${mediaHolders.length - 1}\u0006`;
    })
    .replace(/<img\b[^>]*\/?>/gi, (m) => {
      const ok = sanitizeImg(m);
      if (!ok) return m;
      mediaHolders.push(ok);
      return `\u0005${mediaHolders.length - 1}\u0006`;
    });
  let h = esc(t);
  h = h.replace(/`([^`]+)`/g, "\u0001$1\u0002");
  // Linked thumbnails `[![cap](poster)](clip.mp4)` come before plain
  // images AND plain links (they look like both). Video targets become
  // poster cards; other targets become linked image figures.
  h = h.replace(/\[!\[([^\]]*)\]\(([^)]+)\)\]\(([^)]+)\)/g, (_m, alt, posterInner, targetInner) =>
    `\u0005${(() => {
      mediaHolders.push(linkedMedia(alt, posterInner, targetInner));
      return mediaHolders.length - 1;
    })()}\u0006`
  );
  // ![alt](src) embeds (images AND video-by-extension) come before link
  // matching, otherwise the [alt](src) half would be eaten as a plain link.
  // Placeholders (\u0005) are restored at the end, so captions inside them
  // are never re-processed.
  h = h.replace(/!\[([^\]]*)\]\(([^)]*?(?:\([^)]*\)[^)]*?)*)\)/g, (_m, alt, inner) =>
    `\u0005${(() => {
      mediaHolders.push(parseImageToken(alt, inner));
      return mediaHolders.length - 1;
    })()}\u0006`
  );
  // Bold may contain single-asterisk italics: lazy span + trailing-star guard
  // so `**a *b* c**` (italic-close + bold-close `***`) resolves correctly.
  h = h.replace(/\*\*([\s\S]+?)\*\*(?!\*)/g, "<strong>$1</strong>");
  h = h.replace(/(^|[^*\w])\*([^\s*][^*\n]*?)\*(?![*\w])/g, "$1<em>$2</em>");
  h = h.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  // Bare URLs → links, but never inside code spans, existing anchors, or
  // already-built media figures (their src="..." must not be linkified).
  h = h.split(/(\u0001[\s\S]*?\u0002|\u0005\d+\u0006|<a\b.*?<\/a>|<figure\b.*?<\/figure>)/g).map((part) => {
    if (
      part.startsWith("\u0001") ||
      part.startsWith("\u0005") ||
      part.startsWith("<a") ||
      part.startsWith("<figure")
    )
      return part;
    return part.replace(/(https?:\/\/[^\s<\]\\)]+)/g, (url) => {
      const m = url.match(/^(.*?)([.,;:!?)\]]+)$/);
      const clean = m ? m[1] : url;
      const trail = m ? m[2] : "";
      return `<a href="${clean}" target="_blank" rel="noreferrer">${clean}</a>${trail}`;
    });
  }).join("");
  h = h.replace(/\u0001([\s\S]*?)\u0002/g, "<code>$1</code>");
  h = h.replace(/\u0005(\d+)\u0006/g, (_m, n) => mediaHolders[Number(n)] ?? "");
  return h;
}

// A paragraph that IS just one URL to a media file embeds it instead of
// showing a bare link. Mid-sentence URLs stay links (see inline()).
export function bareMediaLine(text: string): string | null {
  const t = text.trim();
  const m = t.match(/^(https?:\/\/[^\s<>"\]]+)$/);
  if (!m) return null;
  let url = m[1].replace(/[.,;:!?)\]]+$/, "");
  if (!url) return null;
  if (!safeMediaSrc(url)) return null;
  const ext = extOf(url);
  if (!IMAGE_EXTS.has(ext) && !VIDEO_EXTS.has(ext)) return null;
  return mediaTag("", url);
}

export function renderMd(src: string): string {
  try {
    return renderMdInner(src);
  } catch {
    // A single hostile message must never blank the transcript.
    return `<pre>${esc(src.slice(0, 4000))}</pre>`;
  }
}

function renderMdInner(src: string): string {
  const out: string[] = [];
  const lines = src.split("\n");
  let i = 0;
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  let inOl = false;
  const closeOl = () => {
    if (inOl) {
      out.push("</ol>");
      inOl = false;
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      closeList();
      closeOl();
      const lang = fence[1];
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      const known = lang && hljs.getLanguage(lang) ? lang : "plaintext";
      out.push(
        `<div class="codeblock"><div class="codehead"><span>${esc(lang || "code")}</span>` +
          `<button class="copybtn" data-copy="${esc(buf.join("\n"))}">copy</button></div>` +
          `<pre><code class="language-${known}">${esc(buf.join("\n"))}</code></pre></div>`
      );
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    // Markdown tables: header row + |---|---| separator.
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      closeList();
      closeOl();
      const splitRow = (r: string) =>
        r.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      out.push(
        "<table><thead><tr>" +
          head.map((c) => `<th>${c}</th>`).join("") +
          "</tr></thead><tbody>" +
          rows.map((r) => "<tr>" + r.map((c) => `<td>${c}</td>`).join("") + "</tr>").join("") +
          "</tbody></table>"
      );
      continue;
    }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      closeList();
      if (!inOl) {
        out.push("<ol>");
        inOl = true;
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      closeOl();
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      closeList();
      closeOl();
      out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ""))}</blockquote>`);
      i++;
      continue;
    }
    if (line.trim() === "") {
      closeList();
      closeOl();
      i++;
      continue;
    }
    closeList();
    closeOl();
    // paragraph: gather until blank. A lone media URL becomes an embed.
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("```")) {
      buf.push(lines[i]);
      i++;
    }
    const bare = bareMediaLine(buf.join("\n"));
    out.push(bare ?? `<p>${inline(buf.join("\n"))}</p>`);
  }
  closeList();
  closeOl();
  return out.join("\n");
}

// Copy buttons use data-copy; call once per container. Also paints syntax
// highlighting on fenced blocks (github-dark palette, see styles.css),
// resolves local media paths via Tauri, adds load-error fallbacks, and
// click-to-open-full for images.
export function wireCopy(container: HTMLElement): void {
  wireMedia(container);
  container.querySelectorAll<HTMLElement>("pre code[class*='language-']").forEach((c) => {
    if ((c as any)._hl) return;
    (c as any)._hl = true;
    try {
      hljs.highlightElement(c as HTMLElement);
    } catch { /* unknown language: leave plain */ }
  });
  container.querySelectorAll<HTMLButtonElement>("button.copybtn").forEach((b) => {
    if ((b as any)._wired) return;
    (b as any)._wired = true;
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy ?? "");
        b.textContent = "copied";
        setTimeout(() => (b.textContent = "copy"), 1200);
      } catch {
        b.textContent = "failed";
      }
    });
  });
}

// ---- media wiring (local paths, errors, click-to-open) ----

async function openExternal(url: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  } catch {
    /* opener missing or refused: fall through to window.open */
  }
  try {
    window.open(url, "_blank", "noopener");
  } catch {
    /* ignore */
  }
}

// Local videos open in the system player directly off disk (no asset-URL
// round-trip: the external player couldn't reach our WebView's server).
async function openLocalPath(abs: string, fallbackUrl: string): Promise<void> {
  try {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(abs);
    return;
  } catch {
    /* not on disk from this machine (browser dev) or refused */
  }
  if (/^https?:\/\//i.test(fallbackUrl)) return openExternal(fallbackUrl);
}

async function toAssetUrl(localPath: string): Promise<string | null> {
  // Local files ride over plain invoke as data: URIs (see read_media).
  // Returns null when unreadable — caller shows the path fallback.
  try {
    const r = await invoke<{ mime: string; base64: string }>("read_media", {
      path: localPath,
      base: mediaBase || null,
    });
    if (r?.mime && r?.base64) return `data:${r.mime};base64,${r.base64}`;
    return null;
  } catch {
    return null;
  }
}

// Failed loads degrade to a caption + path/URL line instead of a broken
// icon: the reference is never silently lost.
function mediaFallback(fig: HTMLElement, label: string): void {
  if (fig.dataset.fbk) return;
  fig.dataset.fbk = "1";
  fig.classList.add("broken");
  const safe = esc(label.slice(0, 300));
  const isHttp = /^https?:\/\//i.test(label);
  fig.innerHTML =
    `<div class="media-fallback"><span>could not load media</span>` +
    (isHttp
      ? `<a href="${safe}" target="_blank" rel="noreferrer">${safe}</a>`
      : `<code>${safe}</code>`) +
    `</div>`;
}

function wireMedia(container: HTMLElement): void {
  // Local files (-> data: URIs via read_media, Tauri or browser dev).
  // Each element resolves once.
  container
    .querySelectorAll<HTMLElement>("img[data-local]")
    .forEach((m) => {
      const el = m as HTMLImageElement | HTMLVideoElement;
      if ((el as any)._loc) return;
      (el as any)._loc = true;
      const raw = el.getAttribute("data-local") ?? "";
      const fig = el.closest("figure") as HTMLElement | null;
      if (!raw) {
        if (fig) mediaFallback(fig, el.getAttribute("src") ?? "media");
        return;
      }
      const abs = resolveLocal(raw);
      // No src attribute yet (see mediaTag), so no premature error event.
      // Only the read itself can fail us now.
      toAssetUrl(abs).then((url) => {
        if (!el.isConnected) return; // user navigated away mid-load
        if (url) {
          el.setAttribute("src", url);
          el.removeAttribute("data-local");
        } else if (fig) {
          mediaFallback(fig, raw);
        }
      });
    });
  // Remote images: error fallback + click-to-open-full.
  container.querySelectorAll<HTMLImageElement>("figure.media > img").forEach((img) => {
    if ((img as any)._wired) return;
    (img as any)._wired = true;
    const fig = img.closest("figure") as HTMLElement | null;
    img.addEventListener("error", () => {
      if (fig) mediaFallback(fig, img.getAttribute("src") ?? "image");
    });
    img.addEventListener("click", () => {
      const src = img.currentSrc || img.getAttribute("src") || "";
      if (src) openExternal(src).catch(() => {});
    });
  });
  // Video cards: click plays inline (pipeline starts on user gesture
  // only — never at render time, see VIDEO_FACADE). Posters resolve
  // alongside, wherever the sidecar exists.
  wireVideoPosters(container);
  container.querySelectorAll<HTMLButtonElement>("button.media-card").forEach((b) => {
    if ((b as any)._wired) return;
    (b as any)._wired = true;
    b.addEventListener("click", () => playVideoCard(b));
  });
}

function cardFallback(b: HTMLButtonElement, label: string): void {
  const div = document.createElement("div");
  div.className = "media-fallback";
  const s = document.createElement("span");
  s.textContent = "could not load video";
  div.appendChild(s);
  if (/^https?:\/\//i.test(label)) {
    const a = document.createElement("a");
    a.href = label;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = label.slice(0, 300);
    div.appendChild(a);
  } else {
    const c = document.createElement("code");
    c.textContent = label.slice(0, 300);
    div.appendChild(c);
  }
  b.replaceWith(div);
}

function playVideoCard(b: HTMLButtonElement): void {
  const open = b.getAttribute("data-open") ?? "";
  const local = b.getAttribute("data-local-path");
  const caption = b.querySelector(".media-name")?.textContent ?? "video";
  // Build with DOM properties (never innerHTML): caption/src are untrusted.
  const finish = (playSrc: string, extPath: string | null, extUrl: string | null) => {
    const row = document.createElement("div");
    row.className = "media-row";
    const fig = document.createElement("figure");
    fig.className = "media";
    const v = document.createElement("video");
    v.controls = true;
    v.autoplay = true;
    v.preload = "metadata";
    (v as any).playsInline = true;
    v.src = playSrc;
    v.addEventListener("error", () => mediaFallback(fig, open || caption));
    fig.appendChild(v);
    if (caption) {
      const c = document.createElement("figcaption");
      c.textContent = caption;
      fig.appendChild(c);
    }
    row.appendChild(fig);
    if (extPath || extUrl) {
      const x = document.createElement("button");
      x.className = "media-ext";
      x.textContent = "open in player \u2197";
      x.addEventListener("click", () => {
        if (extPath) openLocalPath(extPath, extUrl ?? "").catch(() => {});
        else if (extUrl) openExternal(extUrl).catch(() => {});
      });
      row.appendChild(x);
    }
    b.replaceWith(row);
  };
  if (local) {
    const abs = resolveLocal(local);
    // Data-URI inline play; web-backend mirrors read_media so this works
    // in browser dev too. System player stays one click away regardless.
    toAssetUrl(abs).then((url) => {
      if (url) finish(url, abs, null);
      else cardFallback(b, local);
    });
    return;
  }
  if (open) {
    finish(open, null, open);
    return;
  }
  cardFallback(b, caption);
}
