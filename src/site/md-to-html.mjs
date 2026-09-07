// A small Markdown renderer, covering exactly the shapes the pipeline itself writes:
// proposal pages, journal entries, run records and gate rationales. It is here rather
// than in a library because the pipeline takes exactly two dependencies (decision 0001)
// and a Markdown parser is not going to be the third.
//
// It is deliberately not a general Markdown implementation. It handles ATX headings,
// paragraphs, bullet and numbered lists, GitHub-flavoured tables, fenced code, block
// quotes, thematic breaks, and inline code, emphasis, links and autolinks. Anything it
// does not recognise survives as escaped text in a paragraph, which is the right failure:
// a page shows the words rather than swallowing them.
//
// Every path escapes first and adds markup second, so no content the agents produce can
// introduce an element. That matters more here than the feature list does — the bodies
// this renders are written by language models reading a legacy codebase, and a stray
// angle bracket in a citation must never become a tag.

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Only `http:`, `https:` and `mailto:` links, plus same-document and relative ones,
// become anchors. Anything else (`javascript:` above all, but also `data:` and unknown
// schemes) renders as its own literal text, so a link target in agent-written prose
// cannot become script.
function safeHref(url) {
  const trimmed = String(url ?? "").trim();
  if (/^(https?:\/\/|mailto:|#|\/|\.\/|\.\.\/)/i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  return trimmed;
}

// Code spans are lifted out before any other inline rule runs and put back after the last
// one, so emphasis, link and autolink syntax inside backticks stays literal. The sentinel
// is NUL-delimited because NUL cannot occur in the source files this reads: a printable
// placeholder could collide with the text around it, and a bare index could match a digit
// that was in the prose all along.
const CODE_OPEN = "\u0000c";
const CODE_CLOSE = "\u0000";
const ESC_OPEN = "\u0000e";
const ESC_CLOSE = "\u0000";

// The punctuation a backslash may escape. Deliberately excludes the four characters
// `escapeHtml` rewrites, since by the time this runs an escaped `>` is already `&gt;` and
// no longer looks like the thing the backslash was attached to.
const ESCAPABLE = "\\\\`*_{}\\[\\]()#+\\-.!|~";

// Inline formatting, applied to already-escaped text. Backslash escapes are lifted out
// first: an author who wrote `R-8.\*` means a literal asterisk, and leaving it in place
// would both print the backslash and break the emphasis rule that runs later.
export function inline(text) {
  const escapes = [];
  const codes = [];
  let out = escapeHtml(text).replace(new RegExp(`\\\\([${ESCAPABLE}])`, "g"), (_, ch) => {
    escapes.push(ch);
    return `${ESC_OPEN}${escapes.length - 1}${ESC_CLOSE}`;
  });
  out = out.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `${CODE_OPEN}${codes.length - 1}${CODE_CLOSE}`;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, url) => {
    const href = safeHref(url.replace(/&amp;/g, "&"));
    return href === null ? whole : `<a href="${escapeHtml(href)}">${label}</a>`;
  });
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+)/g, (_, pre, url) => `${pre}<a href="${url}">${url}</a>`);
  // Non-greedy and permitting a lone asterisk inside, so a bold run that contains an
  // escaped or stray `*` still closes at its own delimiter rather than not matching at all.
  out = out.replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, "$1<em>$2</em>");
  out = out.replace(new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, "g"), (_, i) => `<code>${codes[Number(i)]}</code>`);
  return out.replace(new RegExp(`${ESC_OPEN}(\\d+)${ESC_CLOSE}`, "g"), (_, i) => escapes[Number(i)]);
}

const isTableSeparator = (line) => /^\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

export function markdownToHtml(md) {
  const lines = String(md ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let para = [];

  const flushParagraph = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") { flushParagraph(); i += 1; continue; }

    // Fenced code. An unterminated fence runs to the end of the document rather than
    // dropping its content, since a truncated journal entry is still worth reading.
    const fence = /^\s*```+\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1;
      const lang = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : "";
      out.push(`<pre><code${lang}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      // Headings inside a rendered body start at h2: the page's own h1 is its title, and
      // a document must have exactly one h1 and no skipped levels.
      const level = Math.min(6, heading[1].length + 1);
      out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushParagraph(); out.push("<hr>"); i += 1; continue; }

    // A table needs a header row and a separator row beneath it.
    if (line.includes("|") && isTableSeparator(lines[i + 1] ?? "")) {
      flushParagraph();
      const head = splitRow(line);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") { body.push(splitRow(lines[i])); i += 1; }
      out.push([
        `<div class="scroll"><table>`,
        `<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>`,
        `<tbody>${body.map((r) => `<tr>${head.map((_, n) => `<td>${inline(r[n] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody>`,
        `</table></div>`,
      ].join(""));
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered) && !bullet;
      const items = [];
      while (i < lines.length) {
        const m = ordered ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[i]) : /^\s*[-*+]\s+(.*)$/.exec(lines[i]);
        if (m) { items.push([m[1]]); i += 1; continue; }
        // A continuation line is indented text under the item it belongs to.
        if (items.length && /^\s+\S/.test(lines[i])) { items[items.length - 1].push(lines[i].trim()); i += 1; continue; }
        break;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((parts) => `<li>${inline(parts.join(" "))}</li>`).join("")}</${tag}>`);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const quoted = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quoted.push(lines[i].replace(/^\s*>\s?/, "")); i += 1; }
      out.push(`<blockquote>${markdownToHtml(quoted.join("\n"))}</blockquote>`);
      continue;
    }

    para.push(line.trim());
    i += 1;
  }
  flushParagraph();
  return out.join("\n");
}
