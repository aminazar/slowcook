import { describe, it, expect } from "vitest";
import {
  validateAndRepairSpec,
  validateEntityFieldReferences,
  parseEntityCatalog,
} from "./spec-validate.js";
import type { Spec } from "@slowcook-ai/core";

function baseSpec(extra: Partial<Spec> = {}): Spec {
  return {
    story_id: "1",
    title: "test",
    status: "active",
    created_at: "2026-04-26T00:00:00Z",
    supersedes: [],
    superseded_by: null,
    actors: [],
    preconditions: [],
    invariants: [],
    acceptance_scenarios: [],
    non_goals: [],
    ...extra,
  };
}

describe("validateAndRepairSpec — token list pruning", () => {
  it("drops unterminated var() entries (BUG-E regression: story-016 var(--tint-in)", () => {
    const spec = baseSpec({
      proposals: {
        ui_layout: {
          status: "pending",
          proposed_by: "refine-agent",
          tokens_to_reuse: [
            "var(--coral)",
            "var(--tint-celebrate)",
            "var(--tint-in", // truncated
          ],
        },
      },
    });
    const findings = validateAndRepairSpec(spec);
    expect(spec.proposals?.ui_layout?.tokens_to_reuse).toEqual([
      "var(--coral)",
      "var(--tint-celebrate)",
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.action).toBe("dropped");
    expect(findings[0]!.message).toContain("Unterminated var()");
    expect(findings[0]!.path).toBe("proposals.ui_layout.tokens_to_reuse[2]");
  });

  it("drops empty + non-string entries", () => {
    const spec = baseSpec({
      proposals: {
        ui_layout: {
          status: "pending",
          proposed_by: "refine-agent",
          tokens_to_reuse: ["bg-coral", "", "  ", null as unknown as string],
        },
      },
    });
    const findings = validateAndRepairSpec(spec);
    expect(spec.proposals?.ui_layout?.tokens_to_reuse).toEqual(["bg-coral"]);
    expect(findings).toHaveLength(3);
    expect(findings.every((f) => f.action === "dropped")).toBe(true);
  });

  it("drops class-prefix-only tokens (`bg-`, `text-`)", () => {
    const spec = baseSpec({
      proposals: {
        ui_layout: {
          status: "pending",
          proposed_by: "refine-agent",
          tokens_to_reuse: ["bg-coral", "bg-", "text-", "text-foreground"],
        },
      },
    });
    const findings = validateAndRepairSpec(spec);
    expect(spec.proposals?.ui_layout?.tokens_to_reuse).toEqual([
      "bg-coral",
      "text-foreground",
    ]);
    expect(findings.every((f) => f.message.includes("Class-prefix-only"))).toBe(true);
  });

  it("returns empty findings for a clean spec", () => {
    const spec = baseSpec({
      proposals: {
        ui_layout: {
          status: "pending",
          proposed_by: "refine-agent",
          tokens_to_reuse: ["bg-coral", "var(--tint-celebrate)"],
          components_to_reuse: ["src/components/RewoCard.tsx"],
        },
      },
    });
    const findings = validateAndRepairSpec(spec);
    expect(findings).toEqual([]);
  });

  it("works on tokens_to_add too", () => {
    const spec = baseSpec({
      proposals: {
        ui_layout: {
          status: "pending",
          proposed_by: "refine-agent",
          tokens_to_add: ["bg-mauve", "var(--invented"],
        },
      },
    });
    const findings = validateAndRepairSpec(spec);
    expect(spec.proposals?.ui_layout?.tokens_to_add).toEqual(["bg-mauve"]);
    expect(findings[0]!.path).toBe("proposals.ui_layout.tokens_to_add[1]");
  });

  it("no-op when no proposals.ui_layout", () => {
    const spec = baseSpec();
    const findings = validateAndRepairSpec(spec);
    expect(findings).toEqual([]);
  });
});

/**
 * Regression: refine sometimes invents entity fields that don't exist.
 * Story-005 in delgoosh referenced `user.timezone.label` but the
 * Timezone entity has only `name`/`offset`/`offsetStr` — no `label`
 * field. The lint catches this before brew silently grounds against
 * a non-existent field.
 */
const SAMPLE_CATALOG = `
## User \`packages/postgres/src/entities/user.entity.ts\`
- firstName: string
- lastName: string
- email: string | null
- timezone?: Timezone

## Timezone \`packages/postgres/src/entities/timezone.entity.ts\`
- name: string
- offset: number
- offsetStr: string

## Appointment \`packages/postgres/src/entities/appointment.entity.ts\`
- status: AppointmentsStatusEnum
- startDate: Date
- therapist: Therapist
`;

describe("parseEntityCatalog", () => {
  it("indexes entities by lowercased name with their field set", () => {
    const map = parseEntityCatalog(SAMPLE_CATALOG);
    expect(map.get("user")).toEqual(
      new Set(["firstName", "lastName", "email", "timezone"])
    );
    expect(map.get("timezone")).toEqual(
      new Set(["name", "offset", "offsetStr"])
    );
    expect(map.get("appointment")).toEqual(
      new Set(["status", "startDate", "therapist"])
    );
  });

  it("returns empty map for empty input", () => {
    expect(parseEntityCatalog("")).toEqual(new Map());
  });
});

describe("validateEntityFieldReferences", () => {
  it("flags `user.timezone.label` when Timezone has no `label` field (story-005 regression)", () => {
    const spec = baseSpec({
      invariants: [
        "Timezone display reads `user.timezone.label` (string from Timezone relation), never the raw timezone UUID",
      ],
    });
    const findings = validateEntityFieldReferences(spec, SAMPLE_CATALOG);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("`timezone.label`");
    expect(findings[0]!.message).toContain("timezone entity has no `label`");
    expect(findings[0]!.action).toBe("flagged");
  });

  it("does NOT flag valid chained relation traversals (user.timezone, timezone.name)", () => {
    const spec = baseSpec({
      invariants: [
        "The greeting uses `user.timezone.name` to render the patient's local zone",
      ],
    });
    expect(validateEntityFieldReferences(spec, SAMPLE_CATALOG)).toEqual([]);
  });

  it("flags only the FIRST occurrence of a given pair (avoids noise across many invariants)", () => {
    const spec = baseSpec({
      invariants: [
        "Show `user.timezone.label` in the header",
        "Tooltip shows `user.timezone.label` too",
        "Sort by `user.timezone.label`",
      ],
    });
    const findings = validateEntityFieldReferences(spec, SAMPLE_CATALOG);
    expect(findings).toHaveLength(1);
  });

  it("ignores pairs whose LHS isn't a known entity (avoids false positives on `data.value` etc.)", () => {
    const spec = baseSpec({
      invariants: [
        "The page calls `api.fetch()` and reads `result.items[0].name`",
      ],
    });
    expect(validateEntityFieldReferences(spec, SAMPLE_CATALOG)).toEqual([]);
  });

  it("walks api_contract response strings + acceptance_scenarios (not just invariants)", () => {
    const spec = baseSpec({
      api_contract: [
        {
          method: "GET",
          path: "/user/:id",
          request_schema: "",
          responses: {
            "200":
              "Response includes user.firstName and user.bogusField for display",
          },
        },
      ],
      acceptance_scenarios: [
        "Given a user, when the page renders, then `user.fakeField` is shown",
      ],
    });
    const findings = validateEntityFieldReferences(spec, SAMPLE_CATALOG);
    const messages = findings.map((f) => f.message).join("\n");
    // Both bogus refs flagged — across both api_contract AND
    // acceptance_scenarios sections (not just invariants).
    expect(messages).toContain("user.fakeField");
    expect(messages).toContain("user.bogusField");
  });

  it("returns [] when no catalog is provided (defensive — never errors)", () => {
    const spec = baseSpec({
      invariants: ["Reads `user.timezone.label`"],
    });
    expect(validateEntityFieldReferences(spec, "")).toEqual([]);
  });
});
