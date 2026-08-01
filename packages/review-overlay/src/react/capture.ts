// Tab capture (0.19.0) — the screenshot half of review evidence.
//
// getDisplayMedia, ONCE per review session (Amin's ruling over DOM
// serialisation: pixel-perfect, sees cross-origin images and canvas, adds no
// dependency; the price is one "share this tab" prompt). The stream is kept
// alive for the session so every subsequent comment captures silently.
//
// A capture is a CROP around the commented element — not the full viewport —
// because a GitHub comment body caps at ~65k characters, a crop focuses the
// eye, and on a REAL backend the crop is also the least QA data leaked. The
// anchored element gets a highlight ring and the click point a marker, drawn
// on the pixels so no downstream renderer has to reconstruct them. Page-level
// comments capture the whole viewport, downscaled.
//
// Everything geometric is in cropGeometry() — pure, tested without a browser.

export interface CaptureSession {
  /** Grab a frame and crop it around `rect` (viewport CSS px). */
  capture(rect: CropTarget | null): Promise<CaptureResult | null>;
  /** Stop the underlying track — the tab-share pill in the browser goes away. */
  stop(): void;
  readonly live: boolean;
}

export interface CropTarget {
  x: number; y: number; width: number; height: number;
  click?: { x: number; y: number };
}

export interface CaptureResult {
  /** JPEG data URL, sized to fit comment-body budgets. */
  dataUrl: string;
  width: number;
  height: number;
  /** True when the crop is the whole viewport (page-level comment). */
  fullPage: boolean;
}

export interface CropBox { sx: number; sy: number; sw: number; sh: number; scale: number }

/** Pure crop math: pad the element rect, clamp to the frame, downscale to
 *  `maxOut`. `frameW/H` are the captured frame's pixels; `dpr` maps CSS px →
 *  frame px (display captures come back at device resolution). */
export function cropGeometry(
  rect: { x: number; y: number; width: number; height: number },
  frameW: number, frameH: number, dpr: number, pad = 48, maxOut = 800,
): CropBox {
  const sx = Math.max(0, Math.round((rect.x - pad) * dpr));
  const sy = Math.max(0, Math.round((rect.y - pad) * dpr));
  const sw = Math.min(frameW - sx, Math.round((rect.width + pad * 2) * dpr));
  const sh = Math.min(frameH - sy, Math.round((rect.height + pad * 2) * dpr));
  const scale = Math.min(1, maxOut / Math.max(sw, sh, 1));
  return { sx, sy, sw: Math.max(1, sw), sh: Math.max(1, sh), scale };
}

/** Ask for the tab once; hold the track for the whole review session. Returns
 *  null when the reviewer declines or the API is unavailable (SSR, old
 *  browsers) — a comment without a screenshot is still a comment. */
export async function startCaptureSession(): Promise<CaptureSession | null> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) return null;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      // preferCurrentTab is Chromium's hint to top the picker with this tab
      ...( { preferCurrentTab: true } as MediaStreamConstraints),
      video: { frameRate: 5 }, audio: false,
    });
  } catch {
    return null; // declined — never nag; the session simply has no screenshots
  }
  const track = stream.getVideoTracks()[0];
  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  await video.play().catch(() => { /* autoplay is allowed for muted capture */ });

  const session: CaptureSession = {
    get live() { return track?.readyState === "live"; },
    stop() { for (const t of stream.getTracks()) t.stop(); },
    async capture(rectIn) {
      if (track?.readyState !== "live") return null;
      const frameW = video.videoWidth, frameH = video.videoHeight;
      if (!frameW || !frameH) return null;
      // the captured frame is the TAB at device resolution; CSS px scale out
      const dpr = frameW / Math.max(1, window.innerWidth);
      const fullPage = rectIn == null;
      const rect = rectIn ?? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
      const g = cropGeometry(rect, frameW, frameH, dpr, fullPage ? 0 : 48, fullPage ? 1000 : 800);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(g.sw * g.scale);
      canvas.height = Math.round(g.sh * g.scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(video, g.sx, g.sy, g.sw, g.sh, 0, 0, canvas.width, canvas.height);

      // the highlight ring on the element, the marker on the click — drawn on
      // the pixels, so the evidence carries its own pointing
      if (!fullPage) {
        const rx = (rect.x * dpr - g.sx) * g.scale, ry = (rect.y * dpr - g.sy) * g.scale;
        const rw = rect.width * dpr * g.scale, rh = rect.height * dpr * g.scale;
        ctx.strokeStyle = "#ff5a36";
        ctx.lineWidth = Math.max(2, 3 * g.scale);
        ctx.strokeRect(rx, ry, rw, rh);
        const click = (rectIn as CropTarget).click;
        if (click) {
          const cx = (click.x * dpr - g.sx) * g.scale, cy = (click.y * dpr - g.sy) * g.scale;
          ctx.beginPath(); ctx.arc(cx, cy, Math.max(5, 8 * g.scale), 0, Math.PI * 2);
          ctx.fillStyle = "rgba(255,90,54,0.35)"; ctx.fill();
          ctx.beginPath(); ctx.arc(cx, cy, Math.max(2, 3 * g.scale), 0, Math.PI * 2);
          ctx.fillStyle = "#ff5a36"; ctx.fill();
        }
      }
      return { dataUrl: canvas.toDataURL("image/jpeg", 0.72), width: canvas.width, height: canvas.height, fullPage };
    },
  };
  return session;
}
