import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectStrategy } from "./from-prod.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "slowcook-from-prod-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, body: string): string {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body, "utf8");
  return p;
}

describe("detectStrategy", () => {
  it("classifies pure UI helper as A-verbatim", () => {
    const f = write("src/lib/format.ts", `export function fmt() { return "x"; }`);
    expect(detectStrategy(f)).toBe("A-verbatim");
  });

  it("classifies @/utils/supabase/server as C2", () => {
    const f = write("src/utils/supabase/server.ts", `import { createServerClient } from "@supabase/ssr";`);
    expect(detectStrategy(f)).toBe("C2-server-mock");
  });

  it("classifies async Server Component as C2", () => {
    const f = write(
      "src/app/page.tsx",
      `import { cookies } from "next/headers";
export default async function Page() {
  const c = await cookies();
  return <div>{c.toString()}</div>;
}`
    );
    expect(detectStrategy(f)).toBe("C2-server-mock");
  });

  it("classifies client component with fetch as B-di-seam", () => {
    const f = write(
      "src/components/Foo.tsx",
      `"use client";
import { useEffect } from "react";
export function Foo() {
  useEffect(() => { fetch("/api/foo"); }, []);
  return <div />;
}`
    );
    expect(detectStrategy(f)).toBe("B-di-seam");
  });

  it("classifies server action as D-skip", () => {
    const f = write(
      "src/app/actions.ts",
      `"use server";
export async function doIt() {}`
    );
    expect(detectStrategy(f)).toBe("D-skip");
  });

  it("classifies pure JSX client component as A-verbatim", () => {
    const f = write(
      "src/components/Pure.tsx",
      `"use client";
export function Pure({ x }: { x: string }) { return <div>{x}</div>; }`
    );
    expect(detectStrategy(f)).toBe("A-verbatim");
  });
});
