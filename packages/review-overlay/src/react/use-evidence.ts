// useReviewEvidence (0.21.0) — the ONE evidence gatherer, shared by every
// shell. The old overlay and the issue-filing pill used to be able to drift
// apart on what a comment carries; this hook is where the answer lives:
// the 60s breadcrumb tail (+ identity + socket counts) and the ringed
// screenshot crop, captured through the once-per-session tab share.
import { useCallback, useEffect, useRef } from "react";
import { installBreadcrumbRecorder, breadcrumbTail, backendIdentity, socketStats } from "./breadcrumbs.js";
import { startCaptureSession, type CaptureSession } from "./capture.js";
import type { EvidenceTail } from "../comment-format.js";

export interface EvidenceConfig {
  screenshot?: boolean;
  networkTail?: boolean;
  /** Also record request bodies for successful non-GET calls (opt-in). */
  mutationBodies?: boolean;
  /** Frontend build id stamped into every tail. */
  buildId?: string;
}

export interface GatheredEvidence {
  evidence?: EvidenceTail;
  screenshotDataUrl?: string;
  screenshotUrl?: string;
}

export interface UseReviewEvidenceArgs {
  config: EvidenceConfig | undefined;
  /** Upload a large crop (raw base64) and return its URL, or null to skip.
   *  Absent ⇒ large crops are dropped rather than blowing a body cap. */
  upload?: (base64: string, suggestedPath: string) => Promise<string | null>;
}

/** THE CHROME LEAVES THE PHOTO (Amin): a screenshot of the product must not
 *  contain the reviewer's own tooling — the pill, markers, sidebar, attached
 *  windows and any host-declared review chrome all hide for the exposure and
 *  come straight back. `visibility` (not display) so nothing reflows, and the
 *  wait matters: the capture stream runs ~5fps, so the hidden state needs
 *  ~2 frames to actually reach the stream before the grab. */
const CHROME_SELECTOR = "[data-review-widget], [data-review-chrome], [data-slowcook-overlay-ui]";
const CAPTURE_SETTLE_MS = 280;
async function withChromeHidden<T>(fn: () => Promise<T>): Promise<T> {
  const els = Array.from(document.querySelectorAll<HTMLElement>(CHROME_SELECTOR));
  const prior = els.map((el) => el.style.visibility);
  for (const el of els) el.style.visibility = "hidden";
  await new Promise((r) => setTimeout(r, CAPTURE_SETTLE_MS));
  try {
    return await fn();
  } finally {
    els.forEach((el, i) => { el.style.visibility = prior[i] ?? ""; });
  }
}

/** Inline-size budget for hosts with NO upload seam. GitHub REFUSES to
 *  render data: URIs in markdown (delgoosh#886 — the crop was attached and
 *  displayed as nothing), so whenever `upload` exists it is ALWAYS used;
 *  inline is only for renderers that honour data URLs. */
const INLINE_CAP = 40_000;

export function useReviewEvidence(args: UseReviewEvidenceArgs): (rect: { x: number; y: number; width: number; height: number } | null) => Promise<GatheredEvidence> {
  const { config, upload } = args;
  const captureRef = useRef<CaptureSession | null | "declined">(null);

  useEffect(() => {
    if (config?.networkTail) installBreadcrumbRecorder({ mutationBodies: config.mutationBodies === true });
  }, [config?.networkTail, config?.mutationBodies]);

  return useCallback(async (rect) => {
    const out: GatheredEvidence = {};
    if (config?.networkTail) {
      const entries = breadcrumbTail(60_000);
      const frontend = config.buildId;
      const backend = backendIdentity();
      const sockets = socketStats();
      if (entries.length || frontend || backend || sockets) {
        out.evidence = {
          window_ms: 60_000, entries,
          ...(frontend || backend ? { identity: { ...(frontend ? { frontend } : {}), ...(backend ? { backend } : {}) } } : {}),
          ...(sockets ? { sockets } : {}),
        };
      }
    }
    if (!config?.screenshot) return out;
    // an attention-stopped stream is not a refusal: re-ask on the next
    // capture (a prompt per sitting); only an explicit decline stays quiet
    if (captureRef.current !== null && captureRef.current !== "declined" && !captureRef.current.live) {
      captureRef.current = null;
    }
    if (captureRef.current === null) captureRef.current = (await startCaptureSession()) ?? "declined";
    const session = captureRef.current;
    if (session === "declined" || !session.live) return out;
    const shot = await withChromeHidden(() =>
      session.capture(rect ? { ...rect, click: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } } : null));
    if (!shot) return out;
    if (upload) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const url = await upload(shot.dataUrl.split(",")[1] ?? "", `qa/${stamp}.jpg`).catch(() => null);
      if (url) out.screenshotUrl = url;
      else if (shot.dataUrl.length < INLINE_CAP) out.screenshotDataUrl = shot.dataUrl; // upload failed — inline beats losing the evidence
    } else if (shot.dataUrl.length < INLINE_CAP) {
      out.screenshotDataUrl = shot.dataUrl;
    }
    return out;
  }, [config?.networkTail, config?.screenshot, config?.buildId, upload]);
}

/** Resolve the crop rect for an anchored comment: the semantic node if it
 *  still stands, else null (⇒ whole-viewport capture). Re-resolved at submit
 *  time — the page may have scrolled since the pin. */
export function rectForNode(node: string | undefined, attribute = "data-review-node"): { x: number; y: number; width: number; height: number } | null {
  if (!node || typeof document === "undefined") return null;
  const el = document.querySelector(`[${attribute}="${CSS.escape(node)}"]`);
  const r = el?.getBoundingClientRect();
  return r && r.width > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
}
