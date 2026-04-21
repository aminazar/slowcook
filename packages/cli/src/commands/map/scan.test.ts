import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateMap } from "./scan.js";
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
