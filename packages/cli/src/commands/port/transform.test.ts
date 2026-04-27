import { describe, it, expect } from "vitest";
import { transformForPort, mockPathToSrcPath } from "./transform.js";

describe("mockPathToSrcPath", () => {
  it("maps mock/src/components/* → src/components/*", () => {
    expect(mockPathToSrcPath("mock/src/components/rewo/RewoCard.tsx")).toBe(
      "src/components/rewo/RewoCard.tsx"
    );
  });

  it("maps mock/src/app/* → src/app/*", () => {
    expect(mockPathToSrcPath("mock/src/app/(main)/u/[handle]/page.tsx")).toBe(
      "src/app/(main)/u/[handle]/page.tsx"
    );
  });

  it("returns null for scenarios (mock-only)", () => {
    expect(mockPathToSrcPath("mock/scenarios/story-017.ts")).toBeNull();
  });

  it("returns null for scenario-registry (mock-only)", () => {
    expect(mockPathToSrcPath("mock/src/lib/scenario-registry.ts")).toBeNull();
  });

  it("returns null for non-mock-prefixed paths", () => {
    expect(mockPathToSrcPath("src/components/Foo.tsx")).toBeNull();
    expect(mockPathToSrcPath("specs/story-N.yaml")).toBeNull();
  });

  it("returns null for mock subtrees outside src/ (Dockerfile, README, etc.)", () => {
    expect(mockPathToSrcPath("mock/Dockerfile")).toBeNull();
    expect(mockPathToSrcPath("mock/README.md")).toBeNull();
    expect(mockPathToSrcPath("mock/package.json")).toBeNull();
  });
});

describe("transformForPort — useScenarioFixture rewrite", () => {
  it("rewrites the import + the call site", () => {
    const input = `"use client";
import { useScenarioFixture } from "@slowcook-ai/mock-runtime";

interface Pin { id: string }

export function PinsStrip() {
  const pins = useScenarioFixture<Pin[]>("pins");
  return <div>{pins.length}</div>;
}
`;
    const r = transformForPort(input);
    expect(r.output).toContain('import { useDataDomain } from "@/lib/data";');
    expect(r.output).not.toContain("useScenarioFixture");
    expect(r.output).toContain('const pins = useDataDomain<Pin[]>("pins");');
    expect(r.rewrites).toContain("rewrote @slowcook-ai/mock-runtime → @/lib/data import");
    expect(r.rewrites).toContain("rewrote useScenarioFixture(...) → useDataDomain(...)");
  });

  it("preserves other named imports from mock-runtime", () => {
    const input = `import { useScenarioFixture, useScenario } from "@slowcook-ai/mock-runtime";

const x = useScenarioFixture<unknown>("x");
const s = useScenario();
`;
    const r = transformForPort(input);
    // useScenarioFixture import migrated to @/lib/data; useScenario stays
    // on @slowcook-ai/mock-runtime (will fail to compile after port — but
    // that's the brew-stage signal that the production component was
    // using a mock-only API and needs a real-data alternative).
    expect(r.output).toContain('import { useDataDomain } from "@/lib/data";');
    expect(r.output).toContain('import { useScenario } from "@slowcook-ai/mock-runtime";');
  });

  it("is a no-op for files that don't use scenario hooks", () => {
    const input = `export function Spinner() {
  return <div className="spinner" />;
}
`;
    const r = transformForPort(input);
    expect(r.output).toBe(input);
    expect(r.rewrites).toEqual([]);
  });
});

describe("transformForPort — mock-only marker stripping", () => {
  it("strips // @slowcook-mock-only lines", () => {
    const input = `// @slowcook-mock-only — temporary fake-data shape
export const fake = { id: "x" };
`;
    const r = transformForPort(input);
    expect(r.output).not.toContain("@slowcook-mock-only");
    expect(r.output).toContain("export const fake");
    expect(r.rewrites).toContain("stripped // @slowcook-mock-only markers");
  });
});

describe("transformForPort — port-provenance header", () => {
  it("prepends a header naming the source story", () => {
    const input = `export function X() { return null; }\n`;
    const r = transformForPort(input, { storyId: "017" });
    expect(r.output.startsWith("// @slowcook-port-from mock/ (story-017)")).toBe(true);
    expect(r.output).toContain("brew (--mode plate)");
    expect(r.rewrites.some((s) => s.includes("port-provenance header"))).toBe(true);
  });

  it("places the header AFTER 'use client'; if present", () => {
    const input = `"use client";
export function X() { return null; }
`;
    const r = transformForPort(input, { storyId: "017" });
    const lines = r.output.split("\n");
    expect(lines[0]).toBe('"use client";');
    expect(lines[1]).toContain("@slowcook-port-from");
  });

  it("doesn't duplicate the header on re-run (idempotent)", () => {
    const input = `// @slowcook-port-from mock/ (story-017)
export function X() { return null; }
`;
    const r = transformForPort(input, { storyId: "017" });
    expect(r.output).toBe(input);
    expect(r.rewrites).toEqual([]);
  });
});

describe("transformForPort — full integration", () => {
  it("end-to-end: real mock component → ported src component", () => {
    const input = `"use client";
import { useScenarioFixture } from "@slowcook-ai/mock-runtime";

// @slowcook-mock-only — strip when porting
const SHOULD_NOT_PORT_FOOTNOTE = true;

interface Pin { id: string; rewo_id: string; }

export function PinsStrip() {
  const pins = useScenarioFixture<Pin[]>("pins");
  if (pins.length === 0) return null;
  return (
    <ul className="strip">
      {pins.map((p) => <li key={p.id}>{p.rewo_id}</li>)}
    </ul>
  );
}
`;
    const r = transformForPort(input, { storyId: "042" });
    expect(r.output).toContain('"use client";');
    expect(r.output).toContain("// @slowcook-port-from mock/ (story-042)");
    expect(r.output).not.toContain("@slowcook-mock-only");
    expect(r.output).not.toContain("@slowcook-ai/mock-runtime");
    expect(r.output).toContain('import { useDataDomain } from "@/lib/data";');
    expect(r.output).toContain('useDataDomain<Pin[]>("pins")');
    expect(r.rewrites.length).toBe(4); // import, call site, marker, header
  });
});
