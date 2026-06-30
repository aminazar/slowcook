// A shared "comet light" — an INVISIBLE point of light that, every now and then,
// streaks across the viewport. You never see the comet itself; you only see its
// reflection glint across the floating review pills as it passes near them (their
// background catches the sheen and their borders briefly shine). One driver, many
// subscribers, so the overlay pill and the Refine pill reflect the SAME comet in
// sync. Honors prefers-reduced-motion (no comets) and only runs while subscribed.
import { useEffect, useRef, useState, type CSSProperties, type RefObject, type JSX } from "react";

export interface CometLight {
  /** viewport-space position of the (unseen) light, px. */
  x: number;
  y: number;
  /** 0→1→0 intensity envelope over the comet's flight. */
  alpha: number;
  /** the light's colour as an "r,g,b" triplet — usually slowcook coral. */
  rgb: string;
}

// The comet's light is USUALLY slowcook coral; once in a while a warm white or a
// gold streak for variety.
const CORAL = "255,107,107";
const COMET_COLORS = [CORAL, CORAL, CORAL, CORAL, "255,224,205", "255,196,120"];
const pickColor = () => COMET_COLORS[Math.floor(Math.random() * COMET_COLORS.length)]!;

type Sub = (l: CometLight | null) => void;
const subs = new Set<Sub>();
let current: CometLight | null = null;
let raf = 0;
let timer = 0;
let started = false;

const reduced = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function emit(l: CometLight | null) {
  current = l;
  for (const s of subs) s(l);
}

// A point a little outside a random edge of the viewport.
function edgePoint(W: number, H: number): { x: number; y: number } {
  const pad = 120;
  switch (Math.floor(Math.random() * 4)) {
    case 0: return { x: Math.random() * W, y: -pad };           // top
    case 1: return { x: W + pad, y: Math.random() * H };        // right
    case 2: return { x: Math.random() * W, y: H + pad };        // bottom
    default: return { x: -pad, y: Math.random() * H };          // left
  }
}

function launch() {
  if (typeof window === "undefined") return;
  const W = window.innerWidth, H = window.innerHeight;
  // Random direction + path: random entry edge → random exit, re-rolled only if the
  // streak would be too short to actually cross anything.
  const start = edgePoint(W, H);
  let end = edgePoint(W, H);
  for (let i = 0; i < 4 && Math.hypot(end.x - start.x, end.y - start.y) < Math.max(W, H) * 0.5; i++) end = edgePoint(W, H);
  const rgb = pickColor();
  const dur = 2200 + Math.random() * 1300; // 2.2–3.5s flight
  const t0 = performance.now();
  const step = (now: number) => {
    const p = (now - t0) / dur;
    if (p >= 1) { emit(null); schedule(); return; }
    emit({
      x: start.x + (end.x - start.x) * p,
      y: start.y + (end.y - start.y) * p,
      alpha: Math.sin(Math.PI * p), // fade in to the middle, fade out
      rgb,
    });
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}

function schedule() {
  timer = window.setTimeout(launch, 3500 + Math.random() * 6000); // a comet every ~3.5–9.5s
}

function startDriver() {
  if (started || reduced() || typeof window === "undefined") return;
  started = true;
  schedule();
}
function stopDriver() {
  started = false;
  clearTimeout(timer);
  cancelAnimationFrame(raf);
  emit(null);
}

/** Subscribe to the shared comet light. The driver runs only while ≥1 subscriber. */
export function subscribeComet(cb: Sub): () => void {
  subs.add(cb);
  if (subs.size === 1) startDriver();
  cb(current);
  return () => {
    subs.delete(cb);
    if (subs.size === 0) stopDriver();
  };
}

export function useCometLight(): CometLight | null {
  const [l, setL] = useState<CometLight | null>(current);
  useEffect(() => subscribeComet(setL), []);
  return l;
}

/** The reflection an element shows for a given light position — a moving sheen
 *  whose hotspot tracks the light, fading with distance, plus a border glint. */
export function cometReflection(light: CometLight | null, rect: DOMRect | null): { background: string; boxShadow: string; opacity: number } {
  const none = { background: "transparent", boxShadow: "none", opacity: 0 };
  if (!light || !rect) return none;
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const dist = Math.hypot(light.x - cx, light.y - cy);
  const reach = 720; // pills within this radius catch the passing light
  const prox = Math.max(0, 1 - dist / reach);
  // gentle (sub-quadratic) falloff so near-misses still glint clearly; proximity
  // dominates, the flight envelope only modulates, so a close pass is always bright.
  const k = Math.pow(prox, 1.25) * (0.5 + 0.5 * light.alpha);
  if (k <= 0.008) return none;
  const c = light.rgb; // usually slowcook coral
  const lx = light.x - rect.left, ly = light.y - rect.top; // hotspot in pill-local px
  // a hot white core fading to coral reads as a bright reflection sweeping the pill.
  const background =
    `radial-gradient(210px 210px at ${lx.toFixed(0)}px ${ly.toFixed(0)}px,` +
    ` rgba(255,255,255,${Math.min(1, 1.0 * k).toFixed(3)}), rgba(${c},${Math.min(1, 1.05 * k).toFixed(3)}) 30%, rgba(${c},0) 68%)`;
  // the border catches the light: a bright coral ring where the light is, plus a
  // wide outer glow so the whole pill flares as the comet passes.
  const boxShadow =
    `inset 0 0 0 1.5px rgba(${c},${Math.min(1, 1.2 * k).toFixed(3)}),` +
    ` 0 0 ${(14 + 40 * k).toFixed(0)}px rgba(${c},${Math.min(0.85, 0.7 * k).toFixed(3)})`;
  return { background, boxShadow, opacity: 1 };
}

/** Overlay that renders the comet reflection for the pill it's mounted into. It
 *  subscribes to the light itself, so only THIS node re-renders per frame — the
 *  parent pill stays put. Mount as an absolute, inset child of the pill. */
export function CometSheen({ pillRef, radius }: { pillRef: RefObject<HTMLElement | null>; radius: number | string }): JSX.Element {
  const light = useCometLight();
  const rectRef = useRef<DOMRect | null>(null);
  // measure once per comet (the pill rarely moves during a ~3s flight).
  if (light && pillRef.current && !rectRef.current) rectRef.current = pillRef.current.getBoundingClientRect();
  if (!light) rectRef.current = null;
  const r = cometReflection(light, rectRef.current);
  const style: CSSProperties = {
    position: "absolute",
    inset: 0,
    borderRadius: radius,
    pointerEvents: "none",
    background: r.background,
    boxShadow: r.boxShadow,
    opacity: r.opacity,
    mixBlendMode: "screen",
    zIndex: 9,
    transition: "opacity .25s ease",
  };
  return <div aria-hidden data-comet-sheen="" style={style} />;
}
