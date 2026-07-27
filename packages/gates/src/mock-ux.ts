/**
 * MOCK-UX DOCTRINE — the checkable half of the wire→mock UX lessons.
 *
 * Distilled from a full review pass over a storyteller mock (dash v4): the
 * reviewer's pins clustered into a handful of anti-patterns that a machine
 * can see. Those live here, by exit code. The half a machine cannot see
 * (sign literacy, whether a status has a door, whether a cue beats a
 * sentence) lives in the builder's prompt and docs/design/mock-ux.md.
 *
 * Checks:
 *  1. RANGE-MONEY — "$4.10–$7.80" in one element. A range makes the reader
 *     do statistics; show ONE number at a chosen percentile and let colour
 *     carry the confidence.
 *  2. REPEATED-CHIP — the same chip text on 3+ sibling rows. A chip that
 *     never varies is a section header in disguise; hoist it.
 *  3. READING-MEASURE — a paragraph rendered wider than 900px. Full-bleed
 *     text is the desktop face of anti-compactness; give prose a column.
 *  4. CONVERSATIONAL-INPUT — a single-line <input> whose placeholder/label
 *     asks for prose (reply/describe/answer/ask/tell). Conversations are
 *     paragraphs: use a growing multi-line field.
 *  5. ORPHAN-REPLY — a field asking to "reply" on a page with no thread
 *     above it. A field names the move it is asking for RIGHT NOW; nothing
 *     may ask the user to reply to nothing.
 *
 * Driver-agnostic: one string-`evaluate` seam, like the other gates.
 */
import type { GateViolation } from "./types.js";

export interface MockUxFacts {
  ranges: { selector: string; text: string }[];
  repeatedChips: { text: string; count: number }[];
  wideText: { selector: string; width: number; text: string }[];
  proseInputs: { selector: string; hint: string }[];
  orphanReplies: { selector: string; hint: string }[];
}

const MONEY = String.raw`[$£€]\s?\d[\d,]*(?:\.\d+)?`;

export const MOCK_UX_PROBE = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const sel = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      let s = n.tagName.toLowerCase();
      if (n.getAttribute && n.getAttribute('data-affordance')) { parts.unshift(s + '[data-affordance=' + n.getAttribute('data-affordance') + ']'); break; }
      if (n.className && typeof n.className === 'string' && n.className.trim()) s += '.' + n.className.trim().split(/\\s+/)[0];
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const RANGE = new RegExp('${MONEY}\\\\s*[-–—]\\\\s*${MONEY}');
  const ranges = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el) || el.children.length > 2) continue;
    const t = (el.textContent || '').trim();
    if (t.length < 60 && RANGE.test(t)) ranges.push({ selector: sel(el), text: t.slice(0, 60) });
  }

  // A chip that NEVER VARIES across the rows of one list is a header in
  // disguise. A chip whose value differs row to row is doing its job — so
  // judge per SIBLING GROUP, not per page.
  const isChip = (el) => {
    if (!vis(el) || el.children.length) return false;
    const s = (el.textContent || '').trim();
    if (!s || s.length > 22 || s.split(/\\s+/).length > 3) return false;
    const cs = getComputedStyle(el);
    return parseFloat(cs.borderRadius) >= 8 || (el.className || '').toString().includes('chip');
  };
  const repeatedChips = [];
  for (const list of document.querySelectorAll('body *')) {
    const rows = [...list.children].filter(vis);
    if (rows.length < 3) continue;
    const texts = rows.map((r) => { const c = [...r.querySelectorAll('*')].filter(isChip); return c.length === 1 ? c[0].textContent.trim() : null; });
    if (texts.some((x) => x === null)) continue;          // rows without exactly one chip
    const uniq = new Set(texts);
    if (uniq.size === 1) repeatedChips.push({ text: texts[0], count: texts.length });
  }

  const wideText = [];
  for (const el of document.querySelectorAll('p, li, div, span')) {
    if (!vis(el) || el.children.length) continue;
    const t = (el.textContent || '').trim();
    if (t.split(/\\s+/).length < 12) continue;   // only real prose
    const w = el.getBoundingClientRect().width;
    if (w > 900) wideText.push({ selector: sel(el), width: Math.round(w), text: t.slice(0, 50) });
  }

  const PROSE = /(reply|describe|answer|ask|tell us|what you|explain|why)/i;
  const proseInputs = [];
  for (const el of document.querySelectorAll('input')) {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (!['text', 'search', ''].includes(type) || !vis(el)) continue;
    const hint = (el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').trim();
    if (hint && PROSE.test(hint)) proseInputs.push({ selector: sel(el), hint: hint.slice(0, 40) });
  }

  // "reply" with nothing to reply TO: no earlier text block of any length
  const orphanReplies = [];
  const fields = [...document.querySelectorAll('textarea, input')].filter(vis);
  for (const el of fields) {
    const hint = (el.getAttribute('placeholder') || '').trim();
    if (!/^reply\\b/i.test(hint)) continue;
    const top = el.getBoundingClientRect().top;
    let thread = false;
    for (const other of document.querySelectorAll('body *')) {
      if (!vis(other) || other.children.length || other.contains(el)) continue;
      const t = (other.textContent || '').trim();
      if (t.split(/\\s+/).length >= 6 && other.getBoundingClientRect().bottom <= top) { thread = true; break; }
    }
    if (!thread) orphanReplies.push({ selector: sel(el), hint: hint.slice(0, 40) });
  }

  return { ranges, repeatedChips, wideText, proseInputs, orphanReplies };
})()`;

export function judgeMockUx(f: MockUxFacts): GateViolation[] {
  const v: GateViolation[] = [];
  for (const r of f.ranges) {
    v.push({ gate: "mock-ux", selector: r.selector, category: "content",
      evidence: `a money RANGE ("${r.text}") makes the reader do statistics — show one number at a chosen percentile and let colour carry the confidence (no.619)` });
  }
  for (const c of f.repeatedChips) {
    v.push({ gate: "mock-ux", selector: `chip:"${c.text}"`, category: "content",
      evidence: `the chip "${c.text}" repeats on ${c.count} rows — a chip that never varies is a section header in disguise; hoist it (no.619)` });
  }
  for (const w of f.wideText) {
    v.push({ gate: "mock-ux", selector: w.selector, category: "content",
      evidence: `prose rendered ${w.width}px wide ("${w.text}…") — full-bleed text is anti-compactness on desktop; give it a column (no.648/no.649)` });
  }
  for (const p of f.proseInputs) {
    v.push({ gate: "mock-ux", selector: p.selector, category: "content",
      evidence: `a single-line input asks for prose ("${p.hint}") — conversations are paragraphs; use a growing multi-line field (no.616)` });
  }
  for (const o of f.orphanReplies) {
    v.push({ gate: "mock-ux", selector: o.selector, category: "content",
      evidence: `a field says "${o.hint}" with nothing above to reply to — a field names the move it asks for RIGHT NOW (no.652)` });
  }
  return v;
}

export async function checkMockUx(page: { evaluate<T>(expression: string): Promise<T> }): Promise<GateViolation[]> {
  const facts = await page.evaluate<MockUxFacts>(MOCK_UX_PROBE);
  return judgeMockUx(facts);
}
