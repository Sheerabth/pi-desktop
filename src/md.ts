// Tiny markdown renderer: code fences (+copy, +highlight), headings, bold,
// inline code, links, lists, quotes, paragraphs, tables. Pi decides content,
// this only displays it.
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

function inline(s: string): string {
  let h = esc(s);
  h = h.replace(/`([^`]+)`/g, "\u0001$1\u0002");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/(^|[^*\w])\*([^\s*][^*\n]*?)\*(?![*\w])/g, "$1<em>$2</em>");
  h = h.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  // Bare URLs → links, but never inside code spans or existing anchors.
  h = h.split(/(\u0001[\s\S]*?\u0002|<a\b.*?<\/a>)/g).map((part) => {
    if (part.startsWith("\u0001") || part.startsWith("<a")) return part;
    return part.replace(/(https?:\/\/[^\s<\]\\)]+)/g, (url) => {
      const m = url.match(/^(.*?)([.,;:!?)\]]+)$/);
      const clean = m ? m[1] : url;
      const trail = m ? m[2] : "";
      return `<a href="${clean}" target="_blank" rel="noreferrer">${clean}</a>${trail}`;
    });
  }).join("");
  h = h.replace(/\u0001([\s\S]*?)\u0002/g, "<code>$1</code>");
  return h;
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
    // paragraph: gather until blank
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("```")) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(buf.join("\n"))}</p>`);
  }
  closeList();
  closeOl();
  return out.join("\n");
}

// Copy buttons use data-copy; call once per container. Also paints syntax
// highlighting on fenced blocks (github-dark palette, see styles.css).
export function wireCopy(container: HTMLElement): void {
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
