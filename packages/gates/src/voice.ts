/**
 * Voice gate (storyteller P4) — the mock speaks PRODUCT, never process.
 * Two failure modes, both mechanically checkable on the rendered page:
 *  - BANNED VOCABULARY: stage/process words that mark a leak from earlier
 *    artifacts (defaults are generic; consumers extend via options — e.g.
 *    a repo's `.brewing/voice.yaml`). Product-domain words are NEVER
 *    hardcoded here.
 *  - EXPLANATION DENSITY: long narrating paragraphs. A product interface
 *    explains itself; blocks of explanatory prose are a design smell the
 *    walk flags for the builder.
 */
import type { GateViolation } from "./types.js";

export interface VoiceOptions {
  /** Regex sources (case-insensitive) added to the generic defaults. */
  banned?: string[];
  /** Longest tolerated visible text block outside [data-doc]. Default 240. */
  maxBlockChars?: number;
}

/** Generic process-leak markers only — no product vocabulary. */
export const DEFAULT_BANNED = [
  "\\bwireframe\\b",
  "\\blorem ipsum\\b",
  "\\bplaceholder\\b",
  "\\bTODO\\b",
  "\\bWIP\\b",
  "\\bcoming soon\\b",
  "\\bthis (?:page|screen|section) (?:shows|displays|allows)\\b",
];

export interface VoiceFacts {
  blocks: { selector: string; text: string }[];
}

/** Pure classifier — unit-testable. */
export function classifyVoice(facts: VoiceFacts, opts?: VoiceOptions): GateViolation[] {
  const banned = [...DEFAULT_BANNED, ...(opts?.banned ?? [])].map((b) => new RegExp(b, "i"));
  const maxChars = opts?.maxBlockChars ?? 240;
  const out: GateViolation[] = [];
  for (const b of facts.blocks) {
    const hit = banned.find((re) => re.test(b.text));
    if (hit) {
      out.push({ gate: "voice", selector: b.selector, evidence: `banned vocabulary ${String(hit)} in "${b.text.slice(0, 80)}"`, category: "content" });
      continue;
    }
    if (b.text.length > maxChars) {
      out.push({ gate: "voice", selector: b.selector, evidence: `explanatory block (${b.text.length} chars): "${b.text.slice(0, 80)}…" — the interface should explain itself`, category: "content" });
    }
  }
  return out.slice(0, 12);
}

export async function checkVoice(page: { evaluate<T>(expression: string): Promise<T> }, opts?: VoiceOptions): Promise<GateViolation[]> {
  const facts = await page.evaluate<VoiceFacts>(`(() => {
    const blocks = [];
    const nodes = Array.from(document.querySelectorAll('p, li, span, div, td, figcaption, label, h1, h2, h3, h4'));
    for (const el of nodes) {
      if (el.closest('[data-doc]')) continue;                 // sanctioned docs areas
      if (el.children.length > 0) continue;                   // leaf text blocks only
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const text = (el.textContent || '').trim();
      if (!text) continue;
      const aff = el.closest('[data-affordance]');
      const sel = aff ? '[data-affordance="' + aff.getAttribute('data-affordance') + '"]' : el.tagName.toLowerCase();
      blocks.push({ selector: sel, text: text.slice(0, 400) });
      if (blocks.length >= 400) break;
    }
    return { blocks };
  })()`);
  return classifyVoice(facts, opts);
}
