import { describe, it, expect } from "vitest";
import { PLATE_AMENDMENT_SYSTEM } from "./plate.js";

describe("PLATE_AMENDMENT_SYSTEM shape branching (sc#82)", () => {
  it("defaults to nextjs shape when no mockShape passed", () => {
    const out = PLATE_AMENDMENT_SYSTEM("(ctx)");
    expect(out).toContain("plate — slowcook's mockup-amendment agent");
    expect(out).not.toContain("CRITICAL: Mock shape is Vite");
  });

  it("prepends Vite override block when mockShape='vite'", () => {
    const out = PLATE_AMENDMENT_SYSTEM("(ctx)", "vite");
    expect(out).toContain("CRITICAL: Mock shape is Vite");
    expect(out).toContain("react-router-dom");
    expect(out).toContain("scenario-registry.tsx");
    expect(out).toContain("No `'use client'`");
  });

  it("Vite override warns the model that legacy Hard Rules below don't apply", () => {
    const out = PLATE_AMENDMENT_SYSTEM("(ctx)", "vite");
    expect(out).toContain("describe the LEGACY shape and do NOT apply here");
  });

  it("nextjs shape leaves the legacy conventions visible", () => {
    const out = PLATE_AMENDMENT_SYSTEM("(ctx)", "nextjs");
    expect(out).toContain("@slowcook-ai/mock-runtime");
  });
});
