import { describe, it, expect } from "vitest";
import type { Spec } from "@slowcook-ai/core";
import { analyzeSpec, normalizePath, ddlTables } from "./index.js";

function spec(partial: Partial<Spec> & { story_id: string }): Spec {
  return {
    story_id: partial.story_id,
    title: partial.title ?? `story ${partial.story_id}`,
    status: "active",
    created_at: "2026-08-27T00:00:00Z",
    supersedes: [],
    superseded_by: null,
    actors: [],
    preconditions: [],
    invariants: [],
    acceptance_scenarios: [],
    non_goals: [],
    ...partial,
  } as Spec;
}

describe("analyze (S3, #528)", () => {
  it("normalizePath equates :slug / {slug} / [slug] param spellings", () => {
    expect(normalizePath("/api/rewos/:slug/pins")).toBe("/api/rewos/:param/pins");
    expect(normalizePath("/api/rewos/{id}/pins")).toBe("/api/rewos/:param/pins");
    expect(normalizePath("/api/rewos/[rewoId]/pins/")).toBe("/api/rewos/:param/pins");
  });

  it("ddlTables extracts creates and alters, schema-stripped", () => {
    const sql = `CREATE TABLE public.pins (id uuid);\nalter table ONLY rewos add column x int;\ncreate table if not exists "byline_authors" (id uuid);`;
    expect(ddlTables(sql)).toEqual({
      created: ["pins", "byline_authors"],
      altered: ["rewos"],
    });
  });

  it("the 016/017 class: same endpoint, contradictory request fields → conflict citing both", () => {
    const s016 = spec({
      story_id: "016",
      api_contract: [
        { method: "POST", path: "/api/pins", request_schema: { rewoSlug: "string" } },
      ],
    });
    const s017 = spec({
      story_id: "017",
      api_contract: [
        { method: "post", path: "/api/pins", request_schema: { rewo_id: "string" } },
      ],
    });
    const findings = analyzeSpec(s017, [s016], new Set());
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("request-field-conflict");
    expect(findings[0]!.message).toContain("rewo_id");
    expect(findings[0]!.message).toContain("rewoSlug");
    expect(findings[0]!.cites.join(" ")).toContain("story-016");
  });

  it("free-form request schemas are skipped — no deterministic comparison, no false positive", () => {
    const a = spec({
      story_id: "020",
      api_contract: [{ method: "POST", path: "/api/x", request_schema: "free text" }],
    });
    const b = spec({
      story_id: "021",
      api_contract: [{ method: "POST", path: "/api/x", request_schema: { y: 1 } }],
    });
    expect(analyzeSpec(a, [b], new Set())).toHaveLength(0);
  });

  it("two active specs creating the same table → collision", () => {
    const a = spec({
      story_id: "030",
      proposals: { schema: { status: "pending", proposed_by: "t", sql: "create table pins (id uuid);" } },
    });
    const b = spec({
      story_id: "031",
      proposals: { schema: { status: "pending", proposed_by: "t", sql: "CREATE TABLE pins (id uuid);" } },
    });
    const findings = analyzeSpec(a, [b], new Set());
    expect(findings.some((f) => f.kind === "table-create-collision")).toBe(true);
  });

  it("the member_rewos class: cited entity existing nowhere → unknown-entity; known ones pass", () => {
    const s = spec({
      story_id: "019",
      data_contract: { entities: [{ name: "member_rewos" }, { name: "rewos" }] },
    });
    const findings = analyzeSpec(s, [], new Set(["rewos"]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("unknown-entity");
    expect(findings[0]!.message).toContain("member_rewos");
  });

  it("own-DDL and other-active-spec DDL both count as declared — not unknown", () => {
    const other = spec({
      story_id: "040",
      proposals: { schema: { status: "pending", proposed_by: "t", sql: "create table queued (id uuid);" } },
    });
    const s = spec({
      story_id: "041",
      data_contract: { entities: [{ name: "mine" }, { name: "queued" }] },
      proposals: { schema: { status: "pending", proposed_by: "t", sql: "create table mine (id uuid);" } },
    });
    expect(analyzeSpec(s, [other], new Set())).toHaveLength(0);
  });

  it("altering a nonexistent table → unknown-entity", () => {
    const s = spec({
      story_id: "050",
      proposals: { schema: { status: "pending", proposed_by: "t", sql: "alter table ghosts add column x int;" } },
    });
    const findings = analyzeSpec(s, [], new Set(["rewos"]));
    expect(findings.some((f) => f.kind === "unknown-entity" && f.message.includes("ghosts"))).toBe(true);
  });

  it("clean spec against realistic neighbors → zero findings", () => {
    const s = spec({
      story_id: "060",
      api_contract: [{ method: "GET", path: "/api/reactions/remaining", responses: { "200": {} } }],
      data_contract: { entities: [{ name: "rewo_reactions" }] },
    });
    const other = spec({
      story_id: "018",
      api_contract: [{ method: "GET", path: "/api/reactions/remaining", responses: { "200": {} } }],
    });
    expect(analyzeSpec(s, [other], new Set(["rewo_reactions"]))).toHaveLength(0);
  });
});
