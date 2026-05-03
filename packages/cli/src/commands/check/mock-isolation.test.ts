import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMockIsolationCheck, checkFile } from "./mock-isolation.js";

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), "slowcook-isolation-"));
}

function write(repo: string, relPath: string, contents: string): void {
  const full = join(repo, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

describe("runMockIsolationCheck — full repo scan", () => {
  it("returns no violations when there is no mock/ directory", () => {
    const repo = makeRepo();
    const r = runMockIsolationCheck(repo);
    expect(r.violations).toEqual([]);
    expect(r.filesChecked).toBe(0);
  });

  it("returns no violations on a clean mock/", () => {
    const repo = makeRepo();
    write(repo, "mock/src/lib/scenario-registry.ts", `import { defineScenarios } from "@slowcook-ai/mock-runtime";
import story017 from "../../scenarios/story-017";
export const registry = defineScenarios([story017]);
`);
    write(repo, "mock/scenarios/story-017.ts", `import type { Scenario } from "@slowcook-ai/mock-runtime";
const s: Scenario = { id: "017", name: "x", user: null, initialPath: "/", fixtures: {}, expectedInteractions: [] };
export default s;
`);
    const r = runMockIsolationCheck(repo);
    expect(r.violations).toEqual([]);
    expect(r.filesChecked).toBe(2);
  });

  it("flags @/ imports that resolve outside mock/src/", () => {
    const repo = makeRepo();
    // Production-side emotions.ts (vibe sees this in code-map, mistakes it
    // as importable from mock/).
    write(repo, "src/lib/emotions.ts", `export const EMOTIONS = [];`);
    write(repo, "mock/src/components/foo.tsx", `"use client";
import { EMOTIONS } from "@/lib/emotions";
export default function Foo() { return null; }
`);
    const r = runMockIsolationCheck(repo);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.file).toBe("mock/src/components/foo.tsx");
    expect(r.violations[0]!.line).toBe(2);
    expect(r.violations[0]!.importPath).toBe("@/lib/emotions");
    expect(r.violations[0]!.reason).toContain("doesn't exist");
    expect(r.violations[0]!.reason).toContain("Inline what you need");
  });

  it("accepts @/ imports that resolve to a file inside mock/src/", () => {
    const repo = makeRepo();
    write(repo, "mock/src/lib/emotions/index.ts", `export const EMOTIONS = [];`);
    write(repo, "mock/src/components/foo.tsx", `import { EMOTIONS } from "@/lib/emotions";
export default function Foo() { return null; }
`);
    const r = runMockIsolationCheck(repo);
    expect(r.violations).toEqual([]);
  });
});

describe("checkFile — relative imports", () => {
  it("flags `..` paths that escape mock/", () => {
    const repo = makeRepo();
    const file = join(repo, "mock/src/components/leak.tsx");
    const body = `import { foo } from "../../../src/lib/foo";
export default function L() { return null; }
`;
    const v = checkFile(file, body, repo, join(repo, "mock"));
    expect(v).toHaveLength(1);
    expect(v[0]!.reason).toContain("escapes mock/");
  });

  it("accepts relative paths that stay inside mock/", () => {
    const repo = makeRepo();
    const file = join(repo, "mock/src/components/foo.tsx");
    write(repo, "mock/src/components/Bar.tsx", `export default function Bar() { return null; }`);
    const body = `import Bar from "./Bar";
export default function F() { return <Bar />; }
`;
    const v = checkFile(file, body, repo, join(repo, "mock"));
    expect(v).toEqual([]);
  });

  it("flags relative imports to non-existent files", () => {
    const repo = makeRepo();
    const file = join(repo, "mock/src/components/foo.tsx");
    const body = `import Bar from "./does-not-exist";
export default function F() { return null; }
`;
    const v = checkFile(file, body, repo, join(repo, "mock"));
    expect(v).toHaveLength(1);
    expect(v[0]!.reason).toContain("non-existent file");
  });
});

describe("checkFile — npm packages allowed", () => {
  it("allows scoped npm packages like @slowcook-ai/mock-runtime", () => {
    const repo = makeRepo();
    const file = join(repo, "mock/src/components/foo.tsx");
    const body = `import { useScenario } from "@slowcook-ai/mock-runtime";
import Link from "next/link";
import { useState } from "react";
export default function F() { return null; }
`;
    const v = checkFile(file, body, repo, join(repo, "mock"));
    expect(v).toEqual([]);
  });

  it("flags absolute-path imports", () => {
    const repo = makeRepo();
    const file = join(repo, "mock/src/components/foo.tsx");
    const body = `import { foo } from "/etc/passwd";
export default function F() { return null; }
`;
    const v = checkFile(file, body, repo, join(repo, "mock"));
    expect(v).toHaveLength(1);
    expect(v[0]!.reason).toContain("Absolute-path import");
  });
});

describe("checkFile — multiple violations + line numbers", () => {
  it("reports each violation on its own line with correct line number", () => {
    const repo = makeRepo();
    const file = join(repo, "mock/src/components/multi.tsx");
    const body = `// header line
import { A } from "@/lib/missing-A";
import { B } from "react";
import { C } from "@/lib/missing-C";
import D from "../../../prod-leak";
export default function M() { return null; }
`;
    const v = checkFile(file, body, repo, join(repo, "mock"));
    expect(v.map((x) => x.line)).toEqual([2, 4, 5]);
    expect(v[0]!.importPath).toBe("@/lib/missing-A");
    expect(v[1]!.importPath).toBe("@/lib/missing-C");
    expect(v[2]!.importPath).toBe("../../../prod-leak");
  });
});
