/**
 * Shared gate result type. Every check returns a list of violations;
 * empty means clean. Selector is a CSS-selector pointer so PR comments
 * can name the offending element; evidence is a brief string ("18px",
 * "contrast 2.1:1 vs required 4.5:1", etc.).
 */
export interface GateViolation {
  gate: string;
  selector: string;
  evidence: string;
  /**
   * Machine-readable category for report grouping. 0.10.0 uses:
   * - `contrast`: WCAG AA contrast failure
   * - `tap-target`: interactive element below 44×44 CSS px
   * - `overflow`: page has horizontal scroll at a mobile viewport
   * - `focus-visible`: focusable element has no visible :focus-visible ring
   */
  category: "contrast" | "tap-target" | "overflow" | "focus-visible" | "content" | "visual";
}
