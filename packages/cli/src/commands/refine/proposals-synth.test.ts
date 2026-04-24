import { describe, it, expect } from "vitest";
import { synthesizeProposalsFromSpec } from "./proposals-synth.js";
import type { Spec } from "@slowcook-ai/core";

const base: Spec = {
  story_id: "999",
  title: "test",
  status: "active",
  created_at: "2026-04-24T00:00:00Z",
  supersedes: [],
  superseded_by: null,
  actors: [],
  preconditions: [],
  invariants: [],
  acceptance_scenarios: [],
  non_goals: [],
};

describe("synthesizeProposalsFromSpec", () => {
  it("returns empty object when spec has no signals", () => {
    expect(synthesizeProposalsFromSpec(base)).toEqual({});
  });

  it("preserves LLM-emitted proposals without modification", () => {
    const spec: Spec = {
      ...base,
      proposals: {
        schema: {
          status: "approved",
          proposed_by: "refine-agent",
          approved_by: "@pm",
          sql: "create table t (id uuid);",
        },
      },
    };
    const out = synthesizeProposalsFromSpec(spec);
    expect(out.schema?.status).toBe("approved");
    expect(out.schema?.proposed_by).toBe("refine-agent");
  });

  it("synthesises routes from non-/api/ api_contract paths", () => {
    const spec: Spec = {
      ...base,
      api_contract: [
        { method: "GET", path: "/api/bookmarks" } as unknown as never,
        { method: "GET", path: "/me/bookmarks" } as unknown as never,
      ],
    };
    const out = synthesizeProposalsFromSpec(spec);
    expect(out.routes?.paths).toContainEqual({
      path: "/me/bookmarks",
      file: "src/app/(main)/me/bookmarks/page.tsx",
    });
    expect(out.routes?.paths.find((r) => r.path === "/api/bookmarks")).toBeUndefined();
    expect(out.routes?.proposed_by).toBe("spec-body-synth");
  });

  it("extracts path references from ui_behavior prose", () => {
    const spec: Spec = {
      ...base,
      ui_behavior: {
        desktop_light: "At `/me/bookmarks` the page renders with max-w-3xl column.",
      },
    };
    const out = synthesizeProposalsFromSpec(spec);
    expect(out.routes?.paths.some((r) => r.path === "/me/bookmarks")).toBe(true);
  });

  it("synthesises auth from RLS-mentioning invariants", () => {
    const spec: Spec = {
      ...base,
      invariants: [
        "Viewer must be authenticated; handler calls supabase.auth.getUser() first",
        "RLS policy on bookmarks restricts select/insert/delete to rows where `member_id = auth.uid()`",
      ],
    };
    const out = synthesizeProposalsFromSpec(spec);
    expect(out.auth?.proposed_by).toBe("spec-body-synth");
    expect(out.auth?.requirements?.some((r) => /authenticated/i.test(r))).toBe(true);
    expect(
      out.auth?.requirements?.some((r) => /auth\.uid/i.test(r) || /RLS/i.test(r))
    ).toBe(true);
  });

  it("synthesises schema placeholder when invariants imply DDL", () => {
    const spec: Spec = {
      ...base,
      invariants: ["Unique constraint on `bookmarks(member_id, rewo_id)` enforces idempotent saves."],
    };
    const out = synthesizeProposalsFromSpec(spec);
    expect(out.schema?.proposed_by).toBe("spec-body-synth");
    expect(out.schema?.sql).toContain("TODO");
    expect(out.schema?.sql).toContain("bookmarks");
  });

  it("skips schema when no DDL signals are present", () => {
    const spec: Spec = {
      ...base,
      invariants: ["Response status is 200 on success."],
    };
    const out = synthesizeProposalsFromSpec(spec);
    expect(out.schema).toBeUndefined();
  });

  it("normalises <name> dynamic segments to [name] in route proposals (0.11.12)", () => {
    // Regression: spec prose often uses <handle> as a dynamic-segment
    // shorthand while concrete repro scenarios use example handles
    // like /u/amin. Before 0.11.12, deriveRoutes only scanned
    // ui_behavior and produced `/u/amin` as a proposed static route,
    // which mapped to `src/app/(main)/u/amin/page.tsx` — wrong.
    const spec: Spec = {
      ...base,
      invariants: [
        "`/u/<handle>` MUST resolve owner via case-insensitive handle lookup",
      ],
      ui_behavior: {
        desktop_light: "Authenticated visitor at `/u/amin`: page renders",
      },
    };
    const out = synthesizeProposalsFromSpec(spec);
    const paths = out.routes?.paths.map((p) => p.path) ?? [];
    // Coalescence: the concrete /u/amin gets dropped in favor of /u/[handle].
    expect(paths).toContain("/u/[handle]");
    expect(paths).not.toContain("/u/amin");
    // File mapping uses the dynamic form.
    const entry = out.routes?.paths.find((p) => p.path === "/u/[handle]");
    expect(entry?.file).toBe("src/app/(main)/u/[handle]/page.tsx");
  });

  it("keeps distinct routes that differ in non-coalescible ways (0.11.12)", () => {
    // Coalescence must NOT eat a route that differs in path length or
    // has no dynamic sibling. /me/bookmarks + /discover stay separate.
    const spec: Spec = {
      ...base,
      ui_behavior: {
        desktop_light: "Routes: `/me/bookmarks` and `/discover` exist",
      },
    };
    const out = synthesizeProposalsFromSpec(spec);
    const paths = out.routes?.paths.map((p) => p.path) ?? [];
    expect(paths).toEqual(
      expect.arrayContaining(["/discover", "/me/bookmarks"]),
    );
  });

  it("does not override LLM-emitted auth even when invariants match", () => {
    const spec: Spec = {
      ...base,
      invariants: ["Viewer must be authenticated"],
      proposals: {
        auth: {
          status: "approved",
          proposed_by: "refine-agent",
          requirements: ["explicit from LLM"],
        },
      },
    };
    const out = synthesizeProposalsFromSpec(spec);
    expect(out.auth?.proposed_by).toBe("refine-agent");
    expect(out.auth?.requirements).toEqual(["explicit from LLM"]);
  });
});
