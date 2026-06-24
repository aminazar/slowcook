/**
 * Tiny dependency-free Markdown → HTML renderer for the docs studio preview.
 * Covers what the spine docs use: headings, bold/italic/inline-code, fenced code,
 * links, ordered/unordered lists, blockquotes, hr, tables, paragraphs. Not a
 * full CommonMark parser — deliberately small (the overlay ships zero runtime
 * deps). Output is for `dangerouslySetInnerHTML`; all raw text is HTML-escaped
 * first so doc content can't inject markup.
 */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Inline spans: code, bold, italic, links. Operates on already-escaped text. */
function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, (_m, c) => `<strong>${c}</strong>`)
    .replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, p, c) => `${p}<em>${c}</em>`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t, href) => `<a href="${href}" target="_blank" rel="noreferrer">${t}</a>`);
}

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline(esc(para.join(" ")))}</p>`); para = []; }
  };
  while (i < lines.length) {
    const line = lines[i]!;
    // fenced code
    if (/^```/.test(line)) {
      flushPara();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) { buf.push(lines[i]!); i++; }
      i++; // closing fence
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    // horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); out.push("<hr/>"); i++; continue; }
    // heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flushPara(); const lvl = h[1]!.length; out.push(`<h${lvl}>${inline(esc(h[2]!))}</h${lvl}>`); i++; continue; }
    // blockquote
    if (/^>\s?/.test(line)) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) { buf.push(lines[i]!.replace(/^>\s?/, "")); i++; }
      out.push(`<blockquote>${inline(esc(buf.join(" ")))}</blockquote>`);
      continue;
    }
    // table (GFM): a header row, a |---| separator, then rows
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]!)) {
      flushPara();
      const cells = (r: string) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) { rows.push(cells(lines[i]!)); i++; }
      const thead = `<thead><tr>${head.map((c) => `<th>${inline(esc(c))}</th>`).join("")}</tr></thead>`;
      const tbody = `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(esc(c))}</td>`).join("")}</tr>`).join("")}</tbody>`;
      out.push(`<table>${thead}${tbody}</table>`);
      continue;
    }
    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) { buf.push(lines[i]!.replace(/^\s*[-*+]\s+/, "")); i++; }
      out.push(`<ul>${buf.map((b) => `<li>${inline(esc(b))}</li>`).join("")}</ul>`);
      continue;
    }
    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) { buf.push(lines[i]!.replace(/^\s*\d+\.\s+/, "")); i++; }
      out.push(`<ol>${buf.map((b) => `<li>${inline(esc(b))}</li>`).join("")}</ol>`);
      continue;
    }
    // blank line → paragraph break
    if (/^\s*$/.test(line)) { flushPara(); i++; continue; }
    para.push(line.trim());
    i++;
  }
  flushPara();
  return out.join("\n");
}
