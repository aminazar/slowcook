// 0.14.0 — a tiny, dependency-free markdown renderer for comment threads.
// Agent replies arrive as GitHub-flavored markdown; showing `**bold**` raw
// reads as broken. Scope is the conversational subset only: bold, italic,
// inline code, links, bullet/numbered lists, blockquotes, ### headings and
// paragraph breaks. Everything is built as React nodes — no innerHTML.
import type { ReactNode } from "react";

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)\s]+\))/g;

export function mdInline(s: string, keyBase = ""): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0, i = 0;
  for (const m of s.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(s.slice(last, idx));
    const tok = m[0];
    const key = `${keyBase}i${i++}`;
    if (tok.startsWith("`")) out.push(<code key={key} style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.92em", background: "rgba(127,127,127,0.18)", borderRadius: 3, padding: "0 3px" }}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**")) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("[")) {
      const t = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(tok);
      if (t) out.push(<a key={key} href={t[2]} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>{t[1]}</a>);
      else out.push(tok);
    } else out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    last = idx + tok.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

export function MdLite({ text }: { text: string }): ReactNode {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];
  let b = 0;
  const flushList = () => {
    if (!list) return;
    const L = list.ordered ? "ol" : "ul";
    blocks.push(
      <L key={`b${b++}`} style={{ margin: "4px 0", paddingLeft: 18 }}>
        {list.items.map((it, k) => <li key={k} style={{ margin: "2px 0" }}>{mdInline(it, `l${b}-${k}`)}</li>)}
      </L>,
    );
    list = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    blocks.push(
      <div key={`b${b++}`} style={{ borderLeft: "3px solid rgba(127,127,127,0.5)", paddingLeft: 8, margin: "4px 0", opacity: 0.9 }}>
        {quote.map((q, k) => <div key={k}>{mdInline(q, `q${b}-${k}`)}</div>)}
      </div>,
    );
    quote = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const li = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(line);
    const qt = /^\s*>\s?(.*)$/.exec(line);
    const hd = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (li) { flushQuote(); const ordered = /^\s*\d/.test(line); if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; } list.items.push(li[1]!); continue; }
    if (qt) { flushList(); quote.push(qt[1]!); continue; }
    flushList(); flushQuote();
    if (!line.trim()) continue;
    if (hd) { blocks.push(<div key={`b${b++}`} style={{ fontWeight: 700, margin: "6px 0 2px" }}>{mdInline(hd[1]!, `h${b}`)}</div>); continue; }
    blocks.push(<div key={`b${b++}`} style={{ margin: "2px 0" }}>{mdInline(line, `p${b}`)}</div>);
  }
  flushList(); flushQuote();
  return <>{blocks}</>;
}
