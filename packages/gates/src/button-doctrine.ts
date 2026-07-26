/**
 * Button doctrine (storyteller P4) — a button is a VERB:
 *  - label ≤3 words, no sentence punctuation, not empty
 *  - money never in the label text; it rides inside a `[data-price]` child
 *    (the sanctioned price-tag element), which is excluded from the count
 *
 * The behavioral half (destructive actions must surface a confirm step) is
 * enforced by the walk compiler, which clicks `[data-confirm-step]` — a
 * missing confirm fails the walk itself.
 *
 * Driver-agnostic: runs through a minimal string-`evaluate` seam so it works
 * on the BrowserDriver pages (playwright or rustwright) and on raw
 * Playwright pages alike.
 */
import type { GateViolation } from "./types.js";

export interface ButtonFacts {
  selector: string;
  /** label with any [data-price] text removed, trimmed. */
  label: string;
  hasPriceTag: boolean;
}

const MONEY_RE = /[$€£¥]\s?\d|\d+(?:\.\d+)?\s?(?:USD|EUR|GBP)/;
const SENTENCE_PUNCT_RE = /[.!?…;:]\s*$|[.!?…]\s+\S/;

/** Pure classifier — unit-testable without a browser. */
export function classifyButtonLabel(f: ButtonFacts): GateViolation[] {
  const out: GateViolation[] = [];
  const label = f.label.trim();
  if (label.length === 0) {
    out.push({ gate: "button-doctrine", selector: f.selector, evidence: "empty label (icon-only buttons need an aria-label acting as the verb)", category: "content" });
    return out;
  }
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length > 3) {
    out.push({ gate: "button-doctrine", selector: f.selector, evidence: `label has ${words.length} words ("${label.slice(0, 60)}") — a button is a verb, ≤3 words`, category: "content" });
  }
  if (SENTENCE_PUNCT_RE.test(label)) {
    out.push({ gate: "button-doctrine", selector: f.selector, evidence: `label reads as a sentence ("${label.slice(0, 60)}")`, category: "content" });
  }
  if (MONEY_RE.test(label)) {
    out.push({ gate: "button-doctrine", selector: f.selector, evidence: `money in the label text ("${label.slice(0, 60)}") — price belongs in a [data-price] child`, category: "content" });
  }
  return out;
}

/** Collect facts in-page and classify. */
export async function checkButtonDoctrine(page: { evaluate<T>(expression: string): Promise<T> }): Promise<GateViolation[]> {
  const facts = await page.evaluate<ButtonFacts[]>(`(() => {
    const controls = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]'));
    const sel = (el) => {
      const aff = el.closest('[data-affordance]');
      if (aff) return '[data-affordance="' + aff.getAttribute('data-affordance') + '"]';
      const id = el.id ? '#' + el.id : '';
      return el.tagName.toLowerCase() + id;
    };
    return controls.filter((el) => {
      if (el.closest('[data-review-chrome],[data-review-widget]')) return false; // the review pill is REVIEW chrome, not product UI
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).map((el) => {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('[data-price]').forEach((p) => p.remove());
      const aria = el.getAttribute('aria-label') || '';
      const label = (clone.textContent || el.value || aria || '').trim();
      return { selector: sel(el), label, hasPriceTag: !!el.querySelector('[data-price]') };
    });
  })()`);
  return facts.flatMap(classifyButtonLabel).slice(0, 12);
}
