import { describe, it, expect } from "vitest";
import { VIBE_SYSTEM } from "./vibe.js";

describe("VIBE_SYSTEM shape branching (sc#82)", () => {
  it("defaults to nextjs shape when no mockShape passed", () => {
    const out = VIBE_SYSTEM("(ctx)");
    expect(out).toContain("vibe — slowcook's design-first mockup agent");
    expect(out).not.toContain("Vite + React SPA");
    expect(out).not.toContain("CRITICAL: Mock shape is Vite");
  });

  it("prepends Vite override block when mockShape='vite'", () => {
    const out = VIBE_SYSTEM("(ctx)", "vite");
    expect(out).toContain("CRITICAL: Mock shape is Vite");
    expect(out).toContain("mock/src/apps/<role>/screens/<Screen>.tsx");
    expect(out).toContain("mock/src/App.tsx");
    expect(out).toContain("react-router-dom");
    expect(out).not.toContain("next/link\n");  // Vite shape uses react-router-dom
  });

  it("vite override warns about Next.js-specific runtime rules below", () => {
    const out = VIBE_SYSTEM("(ctx)", "vite");
    expect(out).toContain("describes the LEGACY Next.js shape and does NOT apply here");
  });

  it("nextjs shape still references the legacy conventions", () => {
    const out = VIBE_SYSTEM("(ctx)", "nextjs");
    expect(out).toContain("mock/src/lib/scenario-registry.ts");
    expect(out).toContain("@slowcook-ai/mock-runtime");
    expect(out).toContain("next/link");
  });

  it("Vite block specifies the .tsx registry extension explicitly", () => {
    const out = VIBE_SYSTEM("(ctx)", "vite");
    expect(out).toContain("mock/src/lib/scenario-registry.tsx");
  });

  it("Vite block forbids 'use client' directives", () => {
    const out = VIBE_SYSTEM("(ctx)", "vite");
    expect(out).toContain("No `'use client'` directives");
  });
});
