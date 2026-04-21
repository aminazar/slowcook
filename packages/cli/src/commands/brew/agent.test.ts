import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findHandler, outlineFile } from "./agent.js";

function mkRepo(): string {
  return mkdtempSync(join(tmpdir(), "slowcook-brew-helpers-"));
}

describe("findHandler — Next.js App Router mapping", () => {
  it("maps POST /api/rewos to src/app/api/rewos/route.ts", () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, "src/app/api/rewos"), { recursive: true });
      writeFileSync(join(repo, "src/app/api/rewos/route.ts"), "export async function POST() {}", "utf8");

      const result = findHandler(repo, "POST", "/api/rewos");
      expect(result).toMatchObject({
        framework: "next-app-router",
        file: "src/app/api/rewos/route.ts",
        function: "POST",
        exists: true,
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("normalises :param to [param]", () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, "src/app"), { recursive: true });
      const result = findHandler(repo, "POST", "/api/rewos/:rewo_id/reports");
      expect(result.file).toBe("src/app/api/rewos/[rewo_id]/reports/route.ts");
      expect(result.framework).toBe("next-app-router");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("normalises {param} to [param]", () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, "src/app"), { recursive: true });
      const result = findHandler(repo, "GET", "/api/users/{id}");
      expect(result.file).toBe("src/app/api/users/[id]/route.ts");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns exists=false with a create-it note when the route file is missing", () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, "src/app"), { recursive: true });
      const result = findHandler(repo, "POST", "/api/new-route");
      expect(result.exists).toBe(false);
      expect(result.note).toMatch(/does not exist/i);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns framework=unknown when src/app/ is absent", () => {
    const repo = mkRepo();
    try {
      const result = findHandler(repo, "POST", "/api/rewos");
      expect(result.framework).toBe("unknown");
      expect(result.exists).toBe(false);
      expect(result.note).toMatch(/no `src\/app\/`/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("complains when method or path is empty", () => {
    const repo = mkRepo();
    try {
      const result = findHandler(repo, "", "/api/rewos");
      expect(result.framework).toBe("unknown");
      expect(result.note).toMatch(/required/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("outlineFile — compact TS outline", () => {
  it("lists imports and top-level exports with line numbers", () => {
    const src = `import { foo } from "./foo";
import type { Bar } from "./bar";

export function POST(req: Request): Promise<Response> {
  return handle(req);
}

export const MAX_RETRIES = 3;

export interface Config {
  timeout: number;
}

function privateHelper() {
  return 42;
}
`;
    const out = outlineFile("src/app/api/rewos/route.ts", src);
    expect(out).toContain("# outline: src/app/api/rewos/route.ts");
    expect(out).toContain('import { foo } from "./foo"');
    expect(out).toContain('import type { Bar } from "./bar"');
    expect(out).toMatch(/L\d+: export function POST/);
    expect(out).toMatch(/L\d+: export const MAX_RETRIES/);
    expect(out).toMatch(/L\d+: export interface Config/);
    // private (unexported) helper should NOT appear — outline surfaces
    // the public API, keeping the output compact.
    // …unless it's top-level, in which case it's still relevant. We include it.
    expect(out).toMatch(/L\d+: function privateHelper/);
  });

  it("handles a file with no imports or exports gracefully", () => {
    const out = outlineFile("src/utils/constants.ts", "// just a comment\n");
    expect(out).toContain("(no imports or top-level declarations detected");
  });

  it("produces an outline much smaller than the source", () => {
    const big = Array.from({ length: 400 }, (_, i) => `  const x${i} = ${i};`).join("\n") +
      "\n\nexport function one() { return 1; }\nexport function two() { return 2; }\n";
    const out = outlineFile("src/big.ts", big);
    // Source is ~6kB+; outline is small and names exactly the exports.
    expect(out.length).toBeLessThan(big.length / 4);
    expect(out).toMatch(/export function one/);
    expect(out).toMatch(/export function two/);
  });
});
