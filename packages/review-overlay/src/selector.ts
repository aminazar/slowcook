/**
 * Element selector extraction — 0.16.0-α.6.
 *
 * Walks an element's attributes + ancestry to produce a stable selector
 * that plate (and humans) can use to find the element later. Priority
 * matches the 0.13.1-review-overlay design:
 *
 *   1. id              → `#unread-badge`                  (most stable)
 *   2. data-testid     → `[data-testid="unread-badge"]`
 *   3. role + name     → `button[aria-label="Sign in"]`
 *   4. tag.classes     → `span.badge.bg-mint:nth-child(2)`
 *   5. XPath           → `/html/body/div/span[2]`         (last resort)
 *
 * Each strategy returns null when not applicable; `extractSelector`
 * tries them in order and returns the first hit. The selector is
 * always non-empty for a real DOM element.
 *
 * Pure functions; no DOM globals beyond what each function takes as
 * input. Testable in node + jsdom.
 */

export interface ExtractedSelector {
  /** Best stable selector. Always populated. */
  selector: string;
  /** Lower-priority fallback (one rung down the priority list). */
  fallbackSelector: string | null;
  /** Strategy that produced `selector`. */
  strategy: "id" | "data-testid" | "role-name" | "tag-classes" | "xpath";
  /** Raw element tag (lowercased). */
  tag: string;
  /** First 80 chars of trimmed text content; null when empty. */
  textHint: string | null;
  /** Semantic anchor (role + accessible name + container path) — the PRIMARY
   *  anchor when present: it survives DOM churn AND mock→prod, and leaves no
   *  trace in shipped code (computed from the a11y tree). Null when the target
   *  has no (role, name); then the selector below is the only anchor. */
  a11y: A11yPath | null;
}

export function extractSelector(el: Element): ExtractedSelector {
  const tag = el.tagName.toLowerCase();
  const textHint = textHintOf(el);
  const a11y = extractA11yPath(el);

  const ord: Array<{
    strategy: ExtractedSelector["strategy"];
    sel: string | null;
  }> = [
    { strategy: "id", sel: byId(el) },
    { strategy: "data-testid", sel: byTestId(el) },
    { strategy: "role-name", sel: byRoleName(el) },
    { strategy: "tag-classes", sel: byTagClasses(el) },
    { strategy: "xpath", sel: byXPath(el) },
  ];

  let primary: { strategy: ExtractedSelector["strategy"]; sel: string } | null = null;
  let fallback: string | null = null;
  for (const o of ord) {
    if (o.sel === null) continue;
    if (primary === null) {
      primary = { strategy: o.strategy, sel: o.sel };
    } else {
      fallback = o.sel;
      break;
    }
  }

  // Real elements always produce at least an XPath; the null branch
  // here is defensive and would only fire on a detached node.
  if (primary === null) {
    return {
      selector: tag,
      fallbackSelector: null,
      strategy: "tag-classes",
      tag,
      textHint,
      a11y,
    };
  }
  return {
    selector: primary.sel,
    fallbackSelector: fallback,
    strategy: primary.strategy,
    tag,
    textHint,
    a11y,
  };
}

function textHintOf(el: Element): string | null {
  const t = (el.textContent ?? "").trim().replace(/\s+/g, " ");
  if (!t) return null;
  return t.length > 80 ? t.slice(0, 77) + "…" : t;
}

function byId(el: Element): string | null {
  const id = el.id;
  if (!id) return null;
  // Skip auto-generated id patterns React + many UI libs produce.
  if (/^:r[0-9a-z]+:$/.test(id)) return null;        // React useId
  if (/^radix-:r/.test(id)) return null;             // Radix
  if (/^headlessui-/.test(id)) return null;          // Headless UI
  return `#${cssEscapeIdent(id)}`;
}

function byTestId(el: Element): string | null {
  const v = el.getAttribute("data-testid");
  if (!v) return null;
  return `[data-testid="${cssEscapeAttr(v)}"]`;
}

function byRoleName(el: Element): string | null {
  const role = el.getAttribute("role") ?? implicitRoleOf(el);
  if (!role) return null;
  const name = accessibleNameOf(el);
  if (!name) return null;
  return `${el.tagName.toLowerCase()}[aria-label="${cssEscapeAttr(name)}"]`;
}

function byTagClasses(el: Element): string | null {
  const classes = Array.from(el.classList).filter((c) => isMeaningfulClass(c));
  if (classes.length === 0) return null;
  const head = classes.slice(0, 2).map(cssEscapeIdent).join(".");
  // Add nth-child for structural disambiguation when the parent has
  // more than one child of the same tag — common case.
  const parent = el.parentElement;
  let suffix = "";
  if (parent) {
    const sameTag = Array.from(parent.children).filter(
      (c) => c.tagName === el.tagName
    );
    if (sameTag.length > 1) {
      const idx = Array.from(parent.children).indexOf(el) + 1;
      suffix = `:nth-child(${idx})`;
    }
  }
  return `${el.tagName.toLowerCase()}.${head}${suffix}`;
}

function byXPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  // Stop at <body> (and <html>): the `/html/body/` prefix below already
  // accounts for them. Including <body> here produced a `/html/body/body/…`
  // double-body that no resolver could match.
  while (
    node &&
    node.nodeType === 1 &&
    node.tagName.toLowerCase() !== "html" &&
    node.tagName.toLowerCase() !== "body"
  ) {
    const parent: Element | null = node.parentElement;
    if (!parent) break;
    const tag = node.tagName.toLowerCase();
    const sameTag = Array.from(parent.children).filter(
      (c) => c.tagName === node!.tagName
    );
    const idx = sameTag.indexOf(node) + 1;
    parts.unshift(sameTag.length > 1 ? `${tag}[${idx}]` : tag);
    node = parent;
  }
  return "/html/body/" + parts.join("/");
}

/**
 * Implicit roles for the most common elements. Not a complete ARIA map
 * — extends as needed. Matches the most common review-target tags.
 */
function implicitRoleOf(el: Element): string | null {
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case "button": return "button";
    case "a": return el.hasAttribute("href") ? "link" : null;
    case "nav": return "navigation";
    case "main": return "main";
    case "header": return "banner";
    case "footer": return "contentinfo";
    case "section": return "region";
    case "article": return "article";
    case "aside": return "complementary";
    case "form": return "form";
    case "dialog": return "dialog";
    case "ul": case "ol": return "list";
    case "li": return "listitem";
    case "table": return "table";
    case "tr": return "row";
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": return "heading";
    case "img": return "img";
    case "input": {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      return "textbox";
    }
    case "textarea": return "textbox";
    case "select": return "combobox";
    default: return null;
  }
}

function accessibleNameOf(el: Element): string | null {
  // Order: aria-label > aria-labelledby's text > <label for> match >
  // textContent (for buttons / links).
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel.trim() || null;

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy && el.ownerDocument) {
    const ids = labelledBy.split(/\s+/);
    const parts: string[] = [];
    for (const id of ids) {
      const ref = el.ownerDocument.getElementById(id);
      if (ref) parts.push((ref.textContent ?? "").trim());
    }
    if (parts.join(" ").trim()) return parts.join(" ").trim();
  }

  // For form controls, look up associated <label>
  if (el.id && el.ownerDocument) {
    const label = el.ownerDocument.querySelector(`label[for="${cssEscapeAttr(el.id)}"]`);
    if (label) {
      const t = (label.textContent ?? "").trim();
      if (t) return t;
    }
  }

  // textContent is the accessible name for buttons, links, and headings.
  const tag = el.tagName.toLowerCase();
  if (tag === "button" || tag === "a" || /^h[1-6]$/.test(tag) || el.getAttribute("role") === "heading") {
    const t = (el.textContent ?? "").trim().replace(/\s+/g, " ");
    if (t) return t.length > 60 ? t.slice(0, 57) + "…" : t;
  }
  if (tag === "img") {
    const alt = el.getAttribute("alt");
    if (alt && alt.trim()) return alt.trim();
  }
  if (tag === "input" || tag === "textarea") {
    const ph = el.getAttribute("placeholder");
    if (ph && ph.trim()) return ph.trim();
  }
  return null;
}

/**
 * Skip Tailwind utility classes, framework-injected classes, and other
 * volatile-looking class names when picking the seed for tag.classes.
 *
 * These rules are heuristic — false positives only cost selector
 * specificity, not correctness; the XPath fallback always works.
 */
function isMeaningfulClass(c: string): boolean {
  if (!c) return false;
  // Tailwind utilities: bg-*, text-*, p-*, m-*, w-*, h-*, flex,
  // grid, items-*, justify-*, hover:*, sm:*, dark:* etc.
  if (/^(bg|text|p|m|w|h|gap|space|border|rounded|font|leading|tracking|opacity|shadow|ring|grid|flex|items|justify|self|content|order|col|row|min|max|inset|top|right|bottom|left|z|object|overflow|cursor|select|pointer|filter|backdrop|transition|duration|ease|delay|animate|origin|rotate|scale|translate|skew)-/.test(c)) return false;
  if (/^(flex|grid|block|inline|hidden|absolute|relative|fixed|static|sticky|truncate|antialiased|italic|underline|uppercase|lowercase|capitalize)$/.test(c)) return false;
  if (/^(hover|focus|active|disabled|sm|md|lg|xl|2xl|dark):/.test(c)) return false;
  // CSS modules / styled-components / emotion hashes
  if (/^[a-zA-Z]+__[a-zA-Z]+_/.test(c)) return false;     // foo__bar_HASH
  if (/^css-[a-zA-Z0-9]{4,}$/.test(c)) return false;      // emotion css-XXXX
  if (/^_[a-zA-Z0-9]{6,}$/.test(c)) return false;          // module-hashed _XXXX
  return true;
}

function cssEscapeIdent(s: string): string {
  // Lightweight CSS.escape replacement for ident contexts. Keeps
  // alnum + hyphen + underscore; backslash-escapes anything else.
  return s.replace(/[^a-zA-Z0-9_-]/g, (ch) => "\\" + ch);
}

function cssEscapeAttr(s: string): string {
  // Inside double-quoted attribute values: escape backslash + quote.
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * 0.3.0 — Resolve a stored selector back to a live element. Tries the
 * primary selector, then the fallback. Returns null when both miss
 * (pin layer falls back to bbox positioning + a "drifted" indicator).
 *
 * Wraps both querySelector calls in try/catch so a malformed stored
 * selector doesn't blow up the pin pass.
 */
/** An XPath selector starts with `/` or `(/` — CSS selectors never do. */
function looksLikeXPath(sel: string): boolean {
  const s = sel.trimStart();
  return s.startsWith("/") || s.startsWith("(/");
}

/**
 * Resolve one stored selector — CSS via querySelector, XPath via
 * document.evaluate. querySelector THROWS on an XPath string, which is why
 * xpath-strategy comments never used to resolve (they all fell through to
 * "drifted" and froze at their capture bbox).
 *
 * Also tolerates the legacy `/html/body/body/…` double-body that older
 * captures emitted, so previously-filed comments resolve too.
 */
function resolveOne(doc: Document, sel: string): Element | null {
  if (looksLikeXPath(sel)) {
    const candidates = [sel];
    if (sel.includes("/html/body/body/")) {
      candidates.push(sel.replace("/html/body/body/", "/html/body/"));
    }
    for (const xp of candidates) {
      try {
        const r = doc.evaluate(xp, doc, null, /* FIRST_ORDERED_NODE_TYPE */ 9, null);
        const node = r.singleNodeValue;
        if (node && node.nodeType === 1) return node as Element;
      } catch {
        /* malformed xpath — try the next candidate */
      }
    }
    return null;
  }
  try {
    return doc.querySelector(sel);
  } catch {
    return null;
  }
}

export function resolveStoredSelector(
  doc: Document,
  selector: string,
  fallbackSelector: string | null
): { element: Element; usedFallback: boolean } | null {
  const primary = resolveOne(doc, selector);
  if (primary) return { element: primary, usedFallback: false };
  if (fallbackSelector) {
    const fb = resolveOne(doc, fallbackSelector);
    if (fb) return { element: fb, usedFallback: true };
  }
  return null;
}

// ── Semantic (a11y-tree) anchoring — #1 ───────────────────────────────────────
// A semantic anchor is a path of (role, accessible-name) segments: up to two
// nearest NAMED container ancestors (outer→in) plus the target leaf. It's
// computed from the accessibility tree — nothing is injected into the DOM — so it
// leaves no trace in shipped code, survives DOM restructuring, and (because a11y
// semantics are part of the UI shape brew preserves) resolves against the real
// product too, not just the mock. Falls back to the CSS selector when the target
// has no (role, name) or for legacy comments captured before this existed.

export interface A11ySeg { role: string; name: string }
export interface A11yPath { segs: A11ySeg[] }

const CONTAINER_ROLES = new Set([
  "main", "navigation", "banner", "contentinfo", "region", "form", "search",
  "dialog", "article", "list", "listitem", "table", "row", "tabpanel", "complementary", "group",
]);

export function roleOf(el: Element): string | null {
  return el.getAttribute("role") || implicitRoleOf(el);
}

/** Build the semantic anchor for an element; null when it has no (role, name). */
export function extractA11yPath(el: Element): A11yPath | null {
  const role = roleOf(el);
  const name = accessibleNameOf(el);
  if (!role || !name) return null;
  const ctx: A11ySeg[] = [];
  let node = el.parentElement;
  while (node && ctx.length < 2) {
    const r = roleOf(node);
    if (r && CONTAINER_ROLES.has(r)) {
      const n = accessibleNameOf(node);
      if (n) ctx.unshift({ role: r, name: n });
    }
    node = node.parentElement;
  }
  return { segs: [...ctx, { role, name }] };
}

/** Candidate-tag hint per role so resolve doesn't scan the whole document. */
function roleHintSelector(role: string): string {
  switch (role) {
    case "button": return "button,[role=button],input[type=button],input[type=submit]";
    case "link": return "a[href],[role=link]";
    case "heading": return "h1,h2,h3,h4,h5,h6,[role=heading]";
    case "textbox": return "input,textarea,[role=textbox]";
    case "checkbox": return "input[type=checkbox],[role=checkbox]";
    case "radio": return "input[type=radio],[role=radio]";
    case "img": return "img,[role=img]";
    default: return `[role=${cssEscapeIdent(role)}]`;
  }
}

function namedContainerAncestors(el: Element): A11ySeg[] {
  const out: A11ySeg[] = [];
  let node = el.parentElement;
  while (node) {
    const r = roleOf(node);
    if (r && CONTAINER_ROLES.has(r)) {
      const n = accessibleNameOf(node);
      if (n) out.push({ role: r, name: n });
    }
    node = node.parentElement;
  }
  return out;
}

/** Resolve a semantic anchor back to a live element (mock OR real product). */
export function resolveA11yPath(doc: Document, path: A11yPath): Element | null {
  if (!path.segs.length) return null;
  const leaf = path.segs[path.segs.length - 1]!;
  const ctx = path.segs.slice(0, -1);
  let candidates: Element[];
  try {
    candidates = Array.from(doc.querySelectorAll(roleHintSelector(leaf.role)));
  } catch {
    candidates = [];
  }
  const matches = candidates.filter((el) => roleOf(el) === leaf.role && accessibleNameOf(el) === leaf.name);
  if (matches.length === 0) return null;
  if (ctx.length === 0) return matches[0]!;
  // Prefer a match whose named-container ancestors include every context seg.
  for (const el of matches) {
    const anc = namedContainerAncestors(el);
    if (ctx.every((seg) => anc.some((a) => a.role === seg.role && a.name === seg.name))) return el;
  }
  return matches[0]!; // name matched but context didn't — still our best guess
}

/** The unified anchor resolver: semantic first, then selector + fallback. */
export function resolveAnchor(
  doc: Document,
  element: { selector: string; fallback_selector: string | null; a11y?: A11yPath | null }
): { element: Element; via: "a11y" | "selector" | "fallback" } | null {
  if (element.a11y) {
    const hit = resolveA11yPath(doc, element.a11y);
    if (hit) return { element: hit, via: "a11y" };
  }
  const sel = resolveStoredSelector(doc, element.selector, element.fallback_selector);
  if (sel) return { element: sel.element, via: sel.usedFallback ? "fallback" : "selector" };
  return null;
}
