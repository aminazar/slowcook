import { describe, it, expect } from "vitest";
import { renderProposalsSection, draftPrBody } from "./prompts.js";
import type { Spec } from "@slowcook-ai/core";

const baseSpec: Spec = {
  story_id: "042",
  title: "Notifications",
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

describe("renderProposalsSection", () => {
  it("returns empty string when spec has no proposals", () => {
    expect(renderProposalsSection(baseSpec)).toBe("");
  });

  it("renders a schema proposal with Mermaid ERD + raw-SQL details", () => {
    const spec: Spec = {
      ...baseSpec,
      proposals: {
        schema: {
          status: "pending",
          proposed_by: "refine-agent",
          rationale: "Story implies persistence.",
          sql: `create table notifications (
            id uuid primary key,
            recipient_id uuid not null references profiles(id)
          );`,
        },
      },
    };
    const out = renderProposalsSection(spec);
    expect(out).toContain("## Proposals");
    expect(out).toContain("🗄 Schema — ⏳ pending");
    expect(out).toContain("Story implies persistence.");
    expect(out).toContain("```mermaid");
    expect(out).toContain("NOTIFICATIONS {");
    expect(out).toContain("<details><summary>Raw SQL</summary>");
  });

  it("renders status badges for every lifecycle state", () => {
    const spec: Spec = {
      ...baseSpec,
      proposals: {
        schema: {
          status: "approved",
          proposed_by: "refine-agent",
          approved_by: "@aminazar",
          sql: "create table t ( id uuid );",
        },
      },
    };
    expect(renderProposalsSection(spec)).toContain("✅ approved");
  });

  it("renders ui_layout with token lists", () => {
    const spec: Spec = {
      ...baseSpec,
      proposals: {
        ui_layout: {
          status: "pending",
          proposed_by: "refine-agent",
          viewport_coverage: ["desktop-light", "mobile-light"],
          components_to_reuse: ["src/components/ui/Card.tsx"],
          tokens_to_reuse: ["bg-card-bg", "text-foreground/60"],
          tokens_to_add: [],
        },
      },
    };
    const out = renderProposalsSection(spec);
    expect(out).toContain("🎨 UI layout");
    expect(out).toContain("desktop-light, mobile-light");
    expect(out).toContain("`src/components/ui/Card.tsx`");
    expect(out).toContain("`bg-card-bg`, `text-foreground/60`");
  });

  it("renders routes as a markdown table", () => {
    const spec: Spec = {
      ...baseSpec,
      proposals: {
        routes: {
          status: "pending",
          proposed_by: "refine-agent",
          paths: [
            { path: "/notifications", file: "src/app/(main)/notifications/page.tsx" },
          ],
        },
      },
    };
    const out = renderProposalsSection(spec);
    expect(out).toContain("| Path | File |");
    expect(out).toContain("| `/notifications` | `src/app/(main)/notifications/page.tsx` |");
  });

  it("renders deferred proposals with the deferred badge", () => {
    const spec: Spec = {
      ...baseSpec,
      proposals: {
        perf_budget: {
          status: "deferred",
          proposed_by: "refine-agent",
          rationale: "No scale concerns for this story.",
        },
      },
    };
    const out = renderProposalsSection(spec);
    expect(out).toContain("🟡 deferred");
    expect(out).toContain("No scale concerns for this story.");
  });
});

describe("draftPrBody with proposals", () => {
  it("includes proposals section when spec carries proposals", () => {
    const spec: Spec = {
      ...baseSpec,
      proposals: {
        infra: {
          status: "pending",
          proposed_by: "refine-agent",
          runtime: "Supabase edge function",
        },
      },
    };
    const body = draftPrBody({
      storyId: "042",
      issueNumber: 91,
      supersedes: [],
      spec,
    });
    expect(body).toContain("## Proposals");
    expect(body).toContain("☁ Infra");
    expect(body).toContain("Supabase edge function");
  });

  it("omits proposals section when spec is absent or proposals are absent", () => {
    const bodyNoSpec = draftPrBody({
      storyId: "042",
      issueNumber: 91,
      supersedes: [],
    });
    expect(bodyNoSpec).not.toContain("## Proposals");

    const bodyNoProposals = draftPrBody({
      storyId: "042",
      issueNumber: 91,
      supersedes: [],
      spec: baseSpec,
    });
    expect(bodyNoProposals).not.toContain("## Proposals");
  });
});
