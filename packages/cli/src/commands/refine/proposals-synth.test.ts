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

  it("synthesises a real CREATE TABLE skeleton when invariants imply a new table (0.14.0-α.3)", () => {
    // Regression from rewo story-015: pre-α.3 this emitted a `-- TODO`
    // placeholder. Brew can't act on a TODO, so the synth now produces
    // a CREATE TABLE skeleton with conventional column types.
    const spec: Spec = {
      ...base,
      invariants: [
        "Unique constraint on `bookmarks(member_id, rewo_id)` enforces idempotent saves.",
      ],
    };
    const out = synthesizeProposalsFromSpec(spec);
    expect(out.schema?.proposed_by).toBe("spec-body-synth");
    const sql = out.schema?.sql ?? "";
    expect(sql).toContain("create table bookmarks");
    expect(sql).toContain("id uuid primary key default gen_random_uuid()");
    expect(sql).toContain("member_id uuid not null");
    expect(sql).toContain("rewo_id uuid not null");
    expect(sql).toContain("created_at timestamptz not null default now()");
  });

  it("schema synth: api_contract response columns join invariant columns (0.14.0-α.3)", () => {
    // story-015 had `pinned_at` only in api_contract responses, never
    // in invariants. The columns union catches it.
    const spec: Spec = {
      ...base,
      invariants: [
        "Unique constraint on `rewo_pins(member_id, rewo_id)` — a rewo cannot be pinned twice.",
      ],
      api_contract: [
        {
          method: "GET",
          path: "/api/profiles/:handle/pins",
          responses: {
            "200": "{ items: Array<{ id: string, rewo_id: string, pinned_at: string }> }",
          },
        },
      ] as Spec["api_contract"],
    };
    const out = synthesizeProposalsFromSpec(spec);
    const sql = out.schema?.sql ?? "";
    expect(sql).toContain("create table rewo_pins");
    expect(sql).toContain("pinned_at timestamptz");
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

  it("schema synth: BUG-F (0.16) — does NOT treat `_id`-suffixed identifiers as tables", () => {
    // Regression: prior heuristic-2 saw `member_id` backticked many
    // times in invariants (FK references in trigger conditions, RLS
    // policies, constraint expressions) + with action-context words
    // ("trigger", "insert"). Result: `create table member_id (...)`.
    const spec: Spec = {
      ...base,
      invariants: [
        "RLS: a member can `INSERT` into `pins` only when `member_id` matches `auth.uid()`.",
        "BEFORE INSERT trigger checks `member_id` exists in `profiles` before inserting into `pins`.",
        "Index on `pins` `(member_id, pinned_at desc)` for fast feed lookups.",
        "Cascade delete: when a row in `profiles` is deleted, the corresponding `member_id` rows in `pins` are removed.",
      ],
    };
    const out = synthesizeProposalsFromSpec(spec);
    const sql = out.schema?.sql ?? "";
    expect(sql).not.toContain("create table member_id");
    // pins should still get detected as a real table
    // (mentioned 4+ times alongside action words).
    expect(sql).toContain("create table pins");
  });

  it("schema synth: BUG-F (0.16) — also excludes `_at`, `_count`, etc. column suffixes", () => {
    const spec: Spec = {
      ...base,
      invariants: [
        "Trigger updates `pinned_at` whenever a `pins` row is touched.",
        "Trigger updates `pinned_at` again on re-pin via the upsert path.",
        "Counter `pin_count` is denormalised on `profiles` for fast-render.",
        "Counter `pin_count` is updated by trigger on insert/delete.",
      ],
    };
    const out = synthesizeProposalsFromSpec(spec);
    const sql = out.schema?.sql ?? "";
    expect(sql).not.toContain("create table pinned_at");
    expect(sql).not.toContain("create table pin_count");
  });

  it("schema synth: BUG-F (0.16) — apiColumns reject English prose words like `containing`", () => {
    // Regression: story-015 had api response prose like
    // `{ items: Array<...> } - object containing fields: ...`
    // and the `containing:` slipped past the column-name extractor.
    const spec: Spec = {
      ...base,
      invariants: [
        "Unique constraint on `(member_id, rewo_id)` in `pins`.",
      ],
      api_contract: [
        {
          method: "GET",
          path: "/api/pins",
          responses: {
            "200": "object containing fields: { id: string, rewo_id: string, pinned_at: string }",
          },
        },
      ] as Spec["api_contract"],
    };
    const out = synthesizeProposalsFromSpec(spec);
    const sql = out.schema?.sql ?? "";
    expect(sql).toContain("create table pins");
    expect(sql).not.toContain("containing text");
  });

  it("schema synth: handles split-form `(cols)` in `<table>` convention (0.14.0-α.4)", () => {
    // Regression: story-015 spec used the Postgres-doc convention
    // "Unique constraint on `(member_id, rewo_id)` in `rewo_pins`" —
    // column list and table name live in separate backticks. Pre-α.4
    // this dropped `member_id` from the synthesised CREATE TABLE.
    const spec: Spec = {
      ...base,
      invariants: [
        "Unique constraint on `(member_id, rewo_id)` in `rewo_pins` — a rewo cannot be pinned twice by the same member.",
      ],
    };
    const out = synthesizeProposalsFromSpec(spec);
    const sql = out.schema?.sql ?? "";
    expect(sql).toContain("create table rewo_pins");
    expect(sql).toContain("member_id uuid");
    expect(sql).toContain("rewo_id uuid");
  });

  it("schema synth: blacklists API error codes — `raising` + `code:` patterns (0.14.0-α.4)", () => {
    // Regression from rewo story-015 re-run: pre-α.4 these slipped through
    // as fake `create table pin_limit_reached` / `pin_requires_reaction`.
    const spec: Spec = {
      ...base,
      invariants: [
        "Each member has at most 5 rows in `rewo_pins` at any time. The 6th insert fails at the DB level via a `BEFORE INSERT` trigger raising `pin_limit_reached`.",
        "Pin requires a matching `rewo_reactions` row for `(member_id, rewo_id)`. Enforced by a `BEFORE INSERT` trigger raising `pin_requires_reaction` when no reaction exists.",
        "Unique constraint on `rewo_pins(member_id, rewo_id)`",
      ],
      api_contract: [
        {
          method: "POST",
          path: "/api/pins",
          responses: {
            "409": '{ error: string, code: "pin_limit_reached" | "already_pinned" | "pin_requires_reaction" }',
          },
        },
      ] as Spec["api_contract"],
    };
    const out = synthesizeProposalsFromSpec(spec);
    const sql = out.schema?.sql ?? "";
    expect(sql).toContain("create table rewo_pins");
    expect(sql).not.toContain("create table pin_limit_reached");
    expect(sql).not.toContain("create table pin_requires_reaction");
    expect(sql).not.toContain("create table already_pinned");
  });

  it("synthesises ui_layout from ui_behavior prose tokens + components (V7)", () => {
    // Regression from rewo story-015: 0.13.6 prompt told the agent to
    // emit proposals.ui_layout when ui_behavior present, but the agent
    // skipped the structured block and put tokens in prose only.
    // The synth now backfills it from the prose.
    const spec: Spec = {
      ...base,
      ui_behavior: {
        desktop_light:
          "Strip cards use `bg-tint-celebrate` with `border border-card-border`, " +
          "title in `text-foreground`, footer in `text-foreground/60`. " +
          "Each row renders via `RewoCard` from `src/components/rewo/rewo-card.tsx`.",
      },
    };
    const out = synthesizeProposalsFromSpec(spec);
    const ui = out.ui_layout;
    expect(ui).toBeDefined();
    expect(ui?.proposed_by).toBe("spec-body-synth");
    expect(ui?.tokens_to_reuse).toContain("bg-tint-celebrate");
    expect(ui?.tokens_to_reuse).toContain("border-card-border");
    expect(ui?.tokens_to_reuse).toContain("text-foreground");
    expect(ui?.components_to_reuse).toContain("src/components/rewo/rewo-card.tsx");
    // The PascalCase backtick name is kept as a weaker-signal entry.
    expect(
      ui?.components_to_reuse?.some((c) => c.includes("RewoCard"))
    ).toBe(true);
  });

  it("ui_layout synth: filters PascalCase candidates by recognized component suffix (POLISH-2)", () => {
    // Regression: pre-α.5 polish, story-015 had `Pin`, `Pinned`, `Unpin`
    // (button-label strings) in components_to_reuse because they're
    // backticked PascalCase. Real components (RewoCard, ProfilePage, etc.)
    // have recognized suffixes; button labels don't.
    const spec: Spec = {
      ...base,
      ui_behavior: {
        desktop_light:
          "On click `Pin`, the row toggles to `Pinned`. " +
          "Each row uses `RewoCard` and the empty state shows a `EmptyPlaceholder`. " +
          "Footer label is `Unpin`.",
      },
    };
    const out = synthesizeProposalsFromSpec(spec);
    const components = out.ui_layout?.components_to_reuse ?? [];
    expect(components.some((c) => c.includes("RewoCard"))).toBe(true);
    expect(components.some((c) => c.includes("EmptyPlaceholder"))).toBe(true);
    expect(components.every((c) => !c.includes("`Pin`"))).toBe(true);
    expect(components.every((c) => !c.includes("`Pinned`"))).toBe(true);
    expect(components.every((c) => !c.includes("`Unpin`"))).toBe(true);
  });

  it("ui_layout synth: skips Tailwind built-in utility classes (POLISH-1)", () => {
    // Regression: pre-α.4 polish, story-015 had `text-sm`, `text-xs`,
    // `border-dashed` in tokens_to_add even though they're standard
    // Tailwind utilities, not project tokens.
    const spec: Spec = {
      ...base,
      ui_behavior: {
        desktop_light:
          "Card uses `bg-card-bg` with `text-foreground` and footer `text-sm` `text-foreground/60`. " +
          "Empty state has `border-dashed` border.",
      },
    };
    const out = synthesizeProposalsFromSpec(spec);
    const adds = out.ui_layout?.tokens_to_add ?? [];
    expect(adds).not.toContain("text-sm");
    expect(adds).not.toContain("text-xs");
    expect(adds).not.toContain("border-dashed");
  });

  it("ui_layout synth: skips when ui_behavior is empty (no UI surface)", () => {
    const spec: Spec = { ...base }; // no ui_behavior
    const out = synthesizeProposalsFromSpec(spec);
    expect(out.ui_layout).toBeUndefined();
  });

  it("synthesises an empty-seed fixtures shell for data-display stories (V7)", () => {
    const spec: Spec = {
      ...base,
      ui_behavior: { desktop_light: "Renders a horizontal strip of pinned cards." },
      api_contract: [
        { method: "GET", path: "/api/profiles/:handle/pins" },
        { method: "POST", path: "/api/pins" },
      ] as Spec["api_contract"],
    };
    const out = synthesizeProposalsFromSpec(spec);
    const fx = out.fixtures;
    expect(fx).toBeDefined();
    expect(fx?.proposed_by).toBe("spec-body-synth");
    expect(fx?.by_domain).toHaveProperty("pins");
    expect(fx?.by_domain?.pins.seed).toEqual({ list: [] });
  });

  it("fixtures synth: skips when no GET endpoint", () => {
    const spec: Spec = {
      ...base,
      ui_behavior: { desktop_light: "Renders a list of items." },
      api_contract: [
        { method: "POST", path: "/api/pins" },
      ] as Spec["api_contract"],
    };
    expect(synthesizeProposalsFromSpec(spec).fixtures).toBeUndefined();
  });

  it("fixtures synth: skips when ui_behavior doesn't imply listing/displaying", () => {
    const spec: Spec = {
      ...base,
      ui_behavior: { desktop_light: "Settings page with a form." },
      api_contract: [
        { method: "GET", path: "/api/settings" },
      ] as Spec["api_contract"],
    };
    expect(synthesizeProposalsFromSpec(spec).fixtures).toBeUndefined();
  });

  it("fixtures synth: preserves LLM-emitted fixtures (no overwrite)", () => {
    const spec: Spec = {
      ...base,
      ui_behavior: { desktop_light: "list of cards" },
      api_contract: [
        { method: "GET", path: "/api/feed" },
      ] as Spec["api_contract"],
      proposals: {
        fixtures: {
          status: "approved",
          proposed_by: "refine-agent",
          by_domain: { feed: { seed: { list: [{ id: "f-1" }] } } },
        },
      },
    };
    const out = synthesizeProposalsFromSpec(spec);
    expect(out.fixtures?.proposed_by).toBe("refine-agent");
    expect(out.fixtures?.by_domain?.feed.seed).toEqual({ list: [{ id: "f-1" }] });
  });

  it("ui_layout synth: preserves LLM-emitted ui_layout (no overwrite)", () => {
    const spec: Spec = {
      ...base,
      ui_behavior: { desktop_light: "uses `bg-coral`" },
      proposals: {
        ui_layout: {
          status: "approved",
          proposed_by: "refine-agent",
          components_to_reuse: ["existing-llm-pick"],
        },
      },
    };
    const out = synthesizeProposalsFromSpec(spec);
    expect(out.ui_layout?.proposed_by).toBe("refine-agent");
    expect(out.ui_layout?.status).toBe("approved");
    expect(out.ui_layout?.components_to_reuse).toEqual(["existing-llm-pick"]);
  });

  it("normalises Express-style :name dynamic segments + synthesises /u/[handle] from /u/alice when api_contract has :handle (0.14.0-α.3)", () => {
    // Regression from rewo story-015 (2026-04-26): spec used :handle
    // throughout (api_contract: /api/profiles/:handle/pins) but pre-α.3
    // regex only recognized [name] and <name>, so /u/:handle in prose
    // was truncated to /u (or skipped), and /u/alice from an acceptance
    // scenario became the only /u/* route. Result: spec-body-synth
    // emitted `path: /u/alice, file: src/app/(main)/u/alice/page.tsx`.
    //
    // Fix: regex accepts :name segments + lifts dynamic names from
    // api_contract paths to synthesise /u/[handle] siblings of literal
    // /u/alice mentions, then coalesces.
    const spec: Spec = {
      ...base,
      api_contract: [
        { method: "GET", path: "/api/profiles/:handle/pins" },
        { method: "POST", path: "/api/pins" },
      ] as Spec["api_contract"],
      preconditions: ["The profile at `/u/:handle` exists."],
      ui_behavior: {
        desktop_light: "On `/u/:handle`, when pins exist OR viewer is owner: a strip renders.",
      },
      acceptance_scenarios: [
        "Given an unauthenticated visitor loading `/u/alice` where alice has 0 pins, When the page renders, Then no strip is shown.",
      ],
    };
    const out = synthesizeProposalsFromSpec(spec);
    const paths = out.routes?.paths.map((p) => p.path) ?? [];
    expect(paths).toContain("/u/[handle]");
    expect(paths).not.toContain("/u/alice");
    expect(paths).not.toContain("/u");
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
