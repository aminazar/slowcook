import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateMap, sliceCodeMap } from "./scan.js";
import type { CodeMap } from "./scan.js";
import { mapsEqual } from "./render.js";

function mkRepo(): string {
  return mkdtempSync(join(tmpdir(), "slowcook-map-"));
}

function writeSrc(repo: string, rel: string, content: string): void {
  const full = join(repo, rel);
  mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  writeFileSync(full, content, "utf8");
}

describe("generateMap — API routes", () => {
  it("extracts POST /api/rewos from an App Router route file", () => {
    const repo = mkRepo();
    try {
      writeSrc(
        repo,
        "src/app/api/rewos/route.ts",
        `import { createClient } from "@/utils/supabase/server";

/**
 * Create a new rewo for the authenticated user.
 */
export async function POST(req: Request): Promise<Response> {
  void createClient;
  void req;
  return new Response(null, { status: 201 });
}
`
      );
      const m = generateMap({ repoRoot: repo, slowcookVersion: "t" });
      expect(m.api_routes).toHaveLength(1);
      expect(m.api_routes[0]).toMatchObject({
        method: "POST",
        path: "/api/rewos",
        file: "src/app/api/rewos/route.ts",
        function: "POST",
      });
      expect(m.api_routes[0]?.jsdoc).toContain("authenticated user");
      expect(m.api_routes[0]?.imports).toContain("@/utils/supabase/server");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("normalises [param] to :param in URL paths", () => {
    const repo = mkRepo();
    try {
      writeSrc(
        repo,
        "src/app/api/rewos/[rewo_id]/reports/route.ts",
        `export async function POST(req: Request): Promise<Response> { void req; return new Response(); }`
      );
      const m = generateMap({ repoRoot: repo, slowcookVersion: "t" });
      expect(m.api_routes[0]?.path).toBe("/api/rewos/:rewo_id/reports");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("drops Next.js route groups like /(auth)/", () => {
    const repo = mkRepo();
    try {
      writeSrc(
        repo,
        "src/app/(auth)/api/login/route.ts",
        `export async function POST(req: Request): Promise<Response> { void req; return new Response(); }`
      );
      const m = generateMap({ repoRoot: repo, slowcookVersion: "t" });
      expect(m.api_routes[0]?.path).toBe("/api/login");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("surfaces multiple HTTP verbs from one route file", () => {
    const repo = mkRepo();
    try {
      writeSrc(
        repo,
        "src/app/api/rewos/[id]/route.ts",
        `export async function GET(req: Request): Promise<Response> { void req; return new Response(); }
export async function DELETE(req: Request): Promise<Response> { void req; return new Response(); }
`
      );
      const m = generateMap({ repoRoot: repo, slowcookVersion: "t" });
      const methods = m.api_routes.map((r) => r.method).sort();
      expect(methods).toEqual(["DELETE", "GET"]);
      expect(m.api_routes[0]?.path).toBe("/api/rewos/:id");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("generateMap — pages and components", () => {
  it("captures default-export pages with component name", () => {
    const repo = mkRepo();
    try {
      writeSrc(
        repo,
        "src/app/feed/page.tsx",
        `export default function FeedPage(): JSX.Element { return <div /> as unknown as JSX.Element; }`
      );
      const m = generateMap({ repoRoot: repo, slowcookVersion: "t" });
      expect(m.pages).toHaveLength(1);
      expect(m.pages[0]).toMatchObject({
        path: "/feed",
        file: "src/app/feed/page.tsx",
        component: "FeedPage",
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("captures components with props type reference", () => {
    const repo = mkRepo();
    try {
      writeSrc(
        repo,
        "src/components/rewo/card.tsx",
        `interface RewoCardProps { id: string; title: string }
export function RewoCard(props: RewoCardProps) { void props; return null as unknown as JSX.Element; }
`
      );
      const m = generateMap({ repoRoot: repo, slowcookVersion: "t" });
      expect(m.components).toHaveLength(1);
      expect(m.components[0]).toMatchObject({
        name: "RewoCard",
        file: "src/components/rewo/card.tsx",
        exportKind: "named",
        props_type: "RewoCardProps",
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("generateMap — helpers and types", () => {
  it("captures exported functions in src/lib/", () => {
    const repo = mkRepo();
    try {
      writeSrc(
        repo,
        "src/lib/rewos.ts",
        `/**
 * Normalise a raw rewo payload before insert.
 */
export function normaliseRewo(raw: unknown): unknown {
  return raw;
}

function privateHelper(): void {}
void privateHelper;
`
      );
      const m = generateMap({ repoRoot: repo, slowcookVersion: "t" });
      const names = m.helpers.map((h) => h.name);
      expect(names).toContain("normaliseRewo");
      expect(names).not.toContain("privateHelper");
      const h = m.helpers.find((x) => x.name === "normaliseRewo");
      expect(h?.jsdoc).toContain("Normalise");
      expect(h?.signature).toMatch(/function normaliseRewo/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("captures exported types, interfaces, and enums from src/types/", () => {
    const repo = mkRepo();
    try {
      writeSrc(
        repo,
        "src/types/rewo.ts",
        `export interface Rewo { id: string; url: string }
export type Emotion = "cheer" | "insight" | "ouch";
export enum Visibility { Public, Connections }
`
      );
      const m = generateMap({ repoRoot: repo, slowcookVersion: "t" });
      expect(m.types.map((t) => t.kind).sort()).toEqual(["enum", "interface", "type"]);
      expect(m.types.find((t) => t.name === "Rewo")?.kind).toBe("interface");
      expect(m.types.find((t) => t.name === "Emotion")?.kind).toBe("type");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("generateMap — Phase 2A enrichment (line + callers)", () => {
  it("populates 1-based `line` for api_routes, components, helpers, types", () => {
    const repo = mkRepo();
    try {
      writeSrc(
        repo,
        "src/app/api/rewos/route.ts",
        `// header line 1
// header line 2
export async function POST(req: Request): Promise<Response> { void req; return new Response(); }
`
      );
      writeSrc(
        repo,
        "src/components/rewo/card.tsx",
        `// banner

export function RewoCard() { return null as unknown as JSX.Element; }
`
      );
      writeSrc(
        repo,
        "src/lib/util.ts",
        `

export function helperA(): void {}
`
      );
      writeSrc(
        repo,
        "src/types/rewo.ts",
        `// types module

export interface Rewo { id: string }
`
      );
      const m = generateMap({ repoRoot: repo, slowcookVersion: "t" });
      expect(m.api_routes[0]?.line).toBe(3);
      expect(m.components[0]?.line).toBe(3);
      expect(m.helpers[0]?.line).toBe(3);
      expect(m.types[0]?.line).toBe(3);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("counts callers across src/ for components, helpers, and types", () => {
    const repo = mkRepo();
    try {
      writeSrc(
        repo,
        "src/lib/math.ts",
        `export function add(a: number, b: number): number { return a + b; }
`
      );
      writeSrc(
        repo,
        "src/lib/consumer.ts",
        `import { add } from "./math";
export function useAddTwice(): number {
  return add(1, 2) + add(3, 4);
}
`
      );
      writeSrc(
        repo,
        "src/lib/single.ts",
        `import { add } from "./math";
export function useAddOnce(): number {
  return add(5, 6);
}
`
      );
      const m = generateMap({ repoRoot: repo, slowcookVersion: "t" });
      const add = m.helpers.find((h) => h.name === "add");
      // 3 call sites (two in consumer, one in single). Imports excluded.
      expect(add?.callers).toBe(3);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("excludes the declaration site itself from callers count", () => {
    const repo = mkRepo();
    try {
      writeSrc(
        repo,
        "src/lib/lonely.ts",
        `export function neverUsed(): void {}
`
      );
      const m = generateMap({ repoRoot: repo, slowcookVersion: "t" });
      expect(m.helpers.find((h) => h.name === "neverUsed")?.callers).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("excludes import-specifier names from callers count", () => {
    // Imports are how a symbol is brought in, not a use site. Without
    // this exclusion the count would always be ≥1 even if the importer
    // never references the symbol after binding it.
    const repo = mkRepo();
    try {
      writeSrc(
        repo,
        "src/lib/source.ts",
        `export function isolated(): void {}
`
      );
      writeSrc(
        repo,
        "src/lib/importer.ts",
        `import { isolated } from "./source";
void isolated;
`
      );
      const m = generateMap({ repoRoot: repo, slowcookVersion: "t" });
      // Two name occurrences in importer.ts: the import-specifier and
      // the `void isolated` reference. We want only the latter counted.
      expect(m.helpers.find((h) => h.name === "isolated")?.callers).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("sliceCodeMap — Phase 2B per-target slicing", () => {
  function fixture(): CodeMap {
    return {
      schema_version: 1,
      slowcook_version: "t",
      generated_at: "2026-04-25T00:00:00Z",
      repo_root: ".",
      api_routes: [
        { method: "POST", path: "/api/bookmarks", file: "src/app/api/bookmarks/route.ts", function: "POST", imports: [] },
        { method: "GET", path: "/api/feed", file: "src/app/api/feed/route.ts", function: "GET", imports: [] },
      ],
      pages: [
        { path: "/bookmarks", file: "src/app/bookmarks/page.tsx", component: "BookmarksPage" },
        { path: "/feed", file: "src/app/feed/page.tsx", component: "FeedPage" },
      ],
      components: [
        { name: "BookmarkItem", file: "src/components/bookmarks/item.tsx", exportKind: "named" },
        { name: "FeedItem", file: "src/components/feed/item.tsx", exportKind: "named" },
      ],
      helpers: [
        { name: "sanitiseUrl", kind: "function", file: "src/lib/bookmarks/sanitise.ts", signature: "function sanitiseUrl(u: string): string" },
        { name: "rateLimit", kind: "function", file: "src/lib/util/rate-limit.ts", signature: "function rateLimit()" },
      ],
      types: [
        { name: "Bookmark", kind: "interface", file: "src/types/bookmark.ts", declaration: "interface Bookmark {}" },
        { name: "FeedEntry", kind: "interface", file: "src/types/feed.ts", declaration: "interface FeedEntry {}" },
      ],
    };
  }

  it("returns the full map when scope is empty (no useful slicing possible)", () => {
    const m = fixture();
    const sliced = sliceCodeMap(m, {});
    expect(sliced.helpers).toHaveLength(2);
    expect(sliced.components).toHaveLength(2);
  });

  it("filters to entries whose file is in scope.files (api_routes + pages by file only)", () => {
    const m = fixture();
    const sliced = sliceCodeMap(m, {
      files: new Set([
        "src/app/api/bookmarks/route.ts",
        "src/components/bookmarks/item.tsx",
        "src/lib/bookmarks/sanitise.ts",
        "src/types/bookmark.ts",
      ]),
    });
    expect(sliced.api_routes.map((r) => r.method)).toEqual(["POST"]);
    expect(sliced.components.map((c) => c.name)).toEqual(["BookmarkItem"]);
    expect(sliced.helpers.map((h) => h.name)).toEqual(["sanitiseUrl"]);
    expect(sliced.types.map((t) => t.name)).toEqual(["Bookmark"]);
    // Pages were not in scope — should be empty.
    expect(sliced.pages).toHaveLength(0);
  });

  it("includes components/helpers/types whose name matches scope.names even if file is out-of-scope", () => {
    const m = fixture();
    const sliced = sliceCodeMap(m, {
      names: new Set(["sanitiseUrl", "Bookmark"]),
    });
    expect(sliced.helpers.map((h) => h.name)).toEqual(["sanitiseUrl"]);
    expect(sliced.types.map((t) => t.name)).toEqual(["Bookmark"]);
    // api_routes/pages are file-scoped only — names don't apply.
    expect(sliced.api_routes).toHaveLength(0);
    expect(sliced.pages).toHaveLength(0);
  });

  it("unions file + name scopes (file matches OR name matches)", () => {
    const m = fixture();
    const sliced = sliceCodeMap(m, {
      files: new Set(["src/lib/bookmarks/sanitise.ts"]),
      names: new Set(["FeedItem"]),
    });
    expect(sliced.helpers.map((h) => h.name)).toEqual(["sanitiseUrl"]);
    expect(sliced.components.map((c) => c.name)).toEqual(["FeedItem"]);
  });

  it("preserves schema metadata (version, generated_at, repo_root)", () => {
    const m = fixture();
    const sliced = sliceCodeMap(m, { names: new Set(["sanitiseUrl"]) });
    expect(sliced.schema_version).toBe(m.schema_version);
    expect(sliced.slowcook_version).toBe(m.slowcook_version);
    expect(sliced.generated_at).toBe(m.generated_at);
    expect(sliced.repo_root).toBe(m.repo_root);
  });

  it("does not mutate the input map", () => {
    const m = fixture();
    const before = JSON.stringify(m);
    sliceCodeMap(m, { names: new Set(["sanitiseUrl"]) });
    expect(JSON.stringify(m)).toBe(before);
  });
});

describe("generateMap — stability", () => {
  it("produces output equal under mapsEqual when regenerated without source changes", () => {
    const repo = mkRepo();
    try {
      writeSrc(
        repo,
        "src/app/api/rewos/route.ts",
        `export async function POST(req: Request): Promise<Response> { void req; return new Response(); }`
      );
      const first = generateMap({ repoRoot: repo, slowcookVersion: "t", now: new Date(0) });
      const second = generateMap({ repoRoot: repo, slowcookVersion: "t", now: new Date(1000) });
      expect(mapsEqual(first, second)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("mapsEqual ignores slowcook_version so a CLI bump alone doesn't fail `map check`", () => {
    const repo = mkRepo();
    try {
      writeSrc(
        repo,
        "src/app/api/rewos/route.ts",
        `export async function POST(req: Request): Promise<Response> { void req; return new Response(); }`
      );
      const committed = generateMap({ repoRoot: repo, slowcookVersion: "0.6.8" });
      const fresh = generateMap({ repoRoot: repo, slowcookVersion: "0.6.9" });
      // Same source tree, different generator version — must be equal.
      expect(mapsEqual(committed, fresh)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns empty lists (no crash) for a repo with no src/", () => {
    const repo = mkRepo();
    try {
      const m = generateMap({ repoRoot: repo, slowcookVersion: "t" });
      expect(m.api_routes).toEqual([]);
      expect(m.pages).toEqual([]);
      expect(m.components).toEqual([]);
      expect(m.helpers).toEqual([]);
      expect(m.types).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
