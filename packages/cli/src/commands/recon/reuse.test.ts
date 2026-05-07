import { describe, it, expect } from "vitest";
import {
  extractStructuralSignature,
  jaccard,
  signatureSimilarity,
  scanForDuplicates,
  pairToRefactorProposal,
  type ScanSignature,
} from "./reuse.js";

describe("extractStructuralSignature", () => {
  it("captures exports / imports / jsxTags / propsUsed / callsUsed for a component", () => {
    const src = `
import React, { useState, useEffect } from "react";
import { cn } from "@/lib/cn";
export function Foo({ id, label }: Props) {
  const [open, setOpen] = useState(false);
  useEffect(() => {}, []);
  return <div className={cn("rounded-full", { "x-y": open })}><span>{label}</span></div>;
}
export default Foo;
`;
    const sig = extractStructuralSignature("src/components/Foo.tsx", src);
    expect(sig.exports).toContain("Foo");
    expect(sig.imports).toContain("React");
    expect(sig.imports).toContain("useState");
    expect(sig.imports).toContain("useEffect");
    expect(sig.imports).toContain("cn");
    expect(sig.jsxTags).toEqual(["div", "span"]);
    expect(sig.propsUsed).toEqual(["id", "label"]);
    expect(sig.callsUsed).toContain("useState");
    expect(sig.callsUsed).toContain("useEffect");
    expect(sig.callsUsed).toContain("cn");
  });

  it("captures API route handler signature (no JSX, async function, db calls)", () => {
    const src = `
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient();
  const userId = await requireAuth(req);
  const { data, error } = await supabase.from("follows").select("*").eq("follower_id", userId);
  if (error) return NextResponse.json({ error: "x" }, { status: 500 });
  return NextResponse.json({ data });
}
`;
    const sig = extractStructuralSignature("src/app/api/follows/route.ts", src);
    expect(sig.exports).toContain("GET");
    expect(sig.jsxTags).toEqual([]); // <-- API: no JSX
    expect(sig.propsUsed).toContain("params"); // second-arg destructure
    // calls: createClient, requireAuth, supabase.from, .select, .eq, NextResponse.json
    expect(sig.callsUsed).toContain("createClient");
    expect(sig.callsUsed).toContain("requireAuth");
    expect(sig.callsUsed).toContain("supabase.from");
    expect(sig.callsUsed).toContain("NextResponse.json");
  });

  it("strips control-flow keywords from callsUsed", () => {
    const src = `
export function f(x: number) {
  if (x > 0) {
    for (let i = 0; i < x; i++) {
      while (i < 3) { i++; }
    }
    return Math.abs(x);
  }
  throw new Error("x");
}
`;
    const sig = extractStructuralSignature("src/lib/f.ts", src);
    expect(sig.callsUsed).not.toContain("if");
    expect(sig.callsUsed).not.toContain("for");
    expect(sig.callsUsed).not.toContain("while");
    expect(sig.callsUsed).not.toContain("return");
    expect(sig.callsUsed).not.toContain("throw");
    expect(sig.callsUsed).toContain("Math.abs");
  });

  it("dedupes + sorts every axis", () => {
    const src = `<div><span><div><span></span></div></span></div>`;
    const sig = extractStructuralSignature("src/x.tsx", src);
    expect(sig.jsxTags).toEqual(["div", "span"]); // sorted, deduped
  });

  it("captures arrow-function destructured params", () => {
    const src = `export const Foo = ({ id, kind }: { id: string; kind: "x" | "y" }) => <div />;`;
    const sig = extractStructuralSignature("src/Foo.tsx", src);
    expect(sig.propsUsed).toEqual(["id", "kind"]);
  });

  it("excludes the file's own export names from callsUsed (regex false positive)", () => {
    // function RewoCard(...)  → 'RewoCard(' matches the call regex
    // but it's a declaration, not a call site. Filter must remove it.
    const src = `
export function RewoCard({ id }: { id: string }) {
  return <div>{id}</div>;
}
`;
    const sig = extractStructuralSignature("src/RewoCard.tsx", src);
    expect(sig.exports).toContain("RewoCard");
    expect(sig.callsUsed).not.toContain("RewoCard");
  });
});

describe("jaccard", () => {
  it("returns 1 when both sets empty", () => {
    expect(jaccard([], [])).toBe(1);
  });

  it("returns 0 when one set empty + the other not", () => {
    expect(jaccard([], ["a"])).toBe(0);
    expect(jaccard(["a"], [])).toBe(0);
  });

  it("returns intersection / union for non-empty sets", () => {
    expect(jaccard(["a", "b", "c"], ["b", "c", "d"])).toBeCloseTo(2 / 4);
  });

  it("returns 1 for identical sets", () => {
    expect(jaccard(["a", "b"], ["a", "b"])).toBe(1);
  });

  it("returns 0 for disjoint non-empty sets", () => {
    expect(jaccard(["a", "b"], ["c", "d"])).toBe(0);
  });
});

const sig = (over: Partial<ScanSignature>): ScanSignature => ({
  path: "x",
  exports: [],
  imports: [],
  jsxTags: [],
  propsUsed: [],
  callsUsed: [],
  ...over,
});

describe("signatureSimilarity", () => {
  it("returns 0 for cross-category (component vs api)", () => {
    const comp = sig({ jsxTags: ["div"], callsUsed: ["useState"] });
    const api = sig({ jsxTags: [], callsUsed: ["NextResponse.json"] });
    expect(signatureSimilarity(comp, api)).toBe(0);
  });

  it("uses jsx-heavy weighting for component-vs-component", () => {
    const a = sig({ jsxTags: ["div", "span", "button"], propsUsed: ["id"], callsUsed: ["useState"] });
    const b = sig({ jsxTags: ["div", "span", "button"], propsUsed: ["id"], callsUsed: ["useState"] });
    expect(signatureSimilarity(a, b)).toBe(1);
  });

  it("returns >0.7 for two near-identical API handlers", () => {
    const a = sig({
      jsxTags: [],
      propsUsed: ["params"],
      callsUsed: ["createClient", "requireAuth", "supabase.from", "NextResponse.json"],
      imports: ["NextRequest", "NextResponse", "createClient"],
    });
    const b = sig({
      jsxTags: [],
      propsUsed: ["params"],
      callsUsed: ["createClient", "requireAuth", "supabase.from", "NextResponse.json"],
      imports: ["NextRequest", "NextResponse", "createClient"],
    });
    expect(signatureSimilarity(a, b)).toBeCloseTo(1);
  });

  it("returns lower similarity when jsx differs but calls match", () => {
    const a = sig({ jsxTags: ["div"], propsUsed: ["id"], callsUsed: ["useState", "useEffect"] });
    const b = sig({ jsxTags: ["span"], propsUsed: ["id"], callsUsed: ["useState", "useEffect"] });
    // jsx jaccard = 0, props = 1, calls = 1
    // weighted: 0.5*0 + 0.3*1 + 0.2*1 = 0.5
    expect(signatureSimilarity(a, b)).toBeCloseTo(0.5);
  });
});

describe("scanForDuplicates", () => {
  it("flags pairs above threshold + sorts by similarity desc", () => {
    const sigs: ScanSignature[] = [
      sig({ path: "src/Foo.tsx", jsxTags: ["div", "span"], propsUsed: ["id"], callsUsed: ["useState"] }),
      sig({ path: "src/Bar.tsx", jsxTags: ["div", "span"], propsUsed: ["id"], callsUsed: ["useState"] }),
      sig({ path: "src/Baz.tsx", jsxTags: ["section"], propsUsed: ["x"], callsUsed: [] }),
    ];
    const pairs = scanForDuplicates(sigs, 0.7);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.a).toBe("src/Foo.tsx");
    expect(pairs[0]!.b).toBe("src/Bar.tsx");
    expect(pairs[0]!.category).toBe("component");
    expect(pairs[0]!.similarity).toBe(1);
  });

  it("returns empty when nothing meets threshold", () => {
    const sigs: ScanSignature[] = [
      sig({ path: "a", jsxTags: ["div"] }),
      sig({ path: "b", jsxTags: ["section"] }),
    ];
    expect(scanForDuplicates(sigs, 0.7)).toEqual([]);
  });

  it("does not pair component with api handler (cross-category short-circuit)", () => {
    const sigs: ScanSignature[] = [
      sig({ path: "src/comp.tsx", jsxTags: ["div"], propsUsed: ["id"], callsUsed: ["useState"] }),
      sig({ path: "src/api.ts", jsxTags: [], propsUsed: ["id"], callsUsed: ["useState"] }),
    ];
    expect(scanForDuplicates(sigs, 0.5)).toEqual([]);
  });

  it("flags two near-identical api files", () => {
    const sigs: ScanSignature[] = [
      sig({
        path: "src/app/api/follows/route.ts",
        callsUsed: ["createClient", "requireAuth", "supabase.from", "NextResponse.json"],
        propsUsed: ["params"],
      }),
      sig({
        path: "src/app/api/blocks/route.ts",
        callsUsed: ["createClient", "requireAuth", "supabase.from", "NextResponse.json"],
        propsUsed: ["params"],
      }),
    ];
    const pairs = scanForDuplicates(sigs, 0.7);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.category).toBe("api-or-util");
  });
});

describe("pairToRefactorProposal", () => {
  it("synthesises a stable id from the sorted file paths", () => {
    const proposal = pairToRefactorProposal({
      a: "src/B.tsx",
      b: "src/A.tsx",
      similarity: 0.85,
      category: "component",
      axes: { jsx: 0.9, props: 0.8, calls: 0.7, imports: 0.5 },
    });
    expect(proposal.id).toMatch(/^reuse-scan\//);
    expect(proposal.id).toContain("src-A-tsx");
    expect(proposal.id).toContain("src-B-tsx");
  });

  it("scales estimatedValueScore from similarity (0.7→5, 1.0→9)", () => {
    const low = pairToRefactorProposal({
      a: "a", b: "b", similarity: 0.7, category: "component",
      axes: { jsx: 1, props: 1, calls: 1, imports: 1 },
    });
    expect(low.estimatedValueScore).toBe(5);
    const high = pairToRefactorProposal({
      a: "a", b: "b", similarity: 1.0, category: "component",
      axes: { jsx: 1, props: 1, calls: 1, imports: 1 },
    });
    expect(high.estimatedValueScore).toBe(9);
  });

  it("uses a category-aware title", () => {
    const c = pairToRefactorProposal({
      a: "a", b: "b", similarity: 0.8, category: "component",
      axes: { jsx: 1, props: 1, calls: 1, imports: 1 },
    });
    expect(c.title).toContain("components");
    const api = pairToRefactorProposal({
      a: "a", b: "b", similarity: 0.8, category: "api-or-util",
      axes: { jsx: 0, props: 1, calls: 1, imports: 1 },
    });
    expect(api.title).toContain("API/utility files");
  });

  it("filesAffected = the two paths from the pair", () => {
    const r = pairToRefactorProposal({
      a: "src/A.tsx", b: "src/B.tsx", similarity: 0.85, category: "component",
      axes: { jsx: 1, props: 1, calls: 1, imports: 1 },
    });
    expect(r.filesAffected).toEqual(["src/A.tsx", "src/B.tsx"]);
  });
});
