import { describe, it, expect } from "vitest";
import { ddlToMermaidErd, __internals } from "./mermaid.js";

describe("ddlToMermaidErd", () => {
  it("returns a safe-empty diagram when no entities are found", () => {
    const out = ddlToMermaidErd("-- just a comment\n");
    expect(out).toContain("```mermaid");
    expect(out).toContain("erDiagram");
    expect(out).toContain("No entities extracted");
  });

  it("renders a simple create-table with typed columns", () => {
    const ddl = `
      create table notifications (
        id uuid primary key default gen_random_uuid(),
        recipient_id uuid not null references profiles(id) on delete cascade,
        read_at timestamptz,
        created_at timestamptz default now()
      );
    `;
    const out = ddlToMermaidErd(ddl);
    expect(out).toContain("NOTIFICATIONS {");
    expect(out).toContain("uuid id PK");
    expect(out).toContain("uuid recipient_id NN,FK");
    expect(out).toContain("timestamptz read_at");
    expect(out).toContain("timestamptz created_at");
  });

  it("renders FK relationships one-to-many by default", () => {
    const ddl = `
      create table notifications (
        id uuid primary key,
        recipient_id uuid not null references profiles(id),
        actor_id uuid not null references profiles(id)
      );
    `;
    const out = ddlToMermaidErd(ddl);
    // Two FKs from profiles → notifications
    expect(out).toMatch(/PROFILES \|\|--o\{ NOTIFICATIONS : "recipient_id"/);
    expect(out).toMatch(/PROFILES \|\|--o\{ NOTIFICATIONS : "actor_id"/);
  });

  it("picks up alter-table add-column forms", () => {
    const ddl = `
      alter table profiles add column handle text not null;
      alter table profiles add column handle_confirmed boolean not null default false;
    `;
    const out = ddlToMermaidErd(ddl);
    expect(out).toContain("PROFILES {");
    expect(out).toContain("text handle NN");
    expect(out).toContain("bool handle_confirmed NN");
  });

  it("skips constraint-only lines", () => {
    const ddl = `
      create table likes (
        user_id uuid,
        rewo_id uuid,
        primary key (user_id, rewo_id),
        constraint likes_unique unique(user_id, rewo_id)
      );
    `;
    const out = ddlToMermaidErd(ddl);
    expect(out).toContain("uuid user_id");
    expect(out).toContain("uuid rewo_id");
    // Constraint-only lines should NOT appear as columns
    expect(out).not.toContain("primary key");
    expect(out).not.toContain("constraint likes_unique");
  });
});

describe("parseColumnLine internals", () => {
  it("parses a simple uuid column", () => {
    const r = __internals.parseColumnLine("id uuid primary key");
    expect(r?.column).toMatchObject({ name: "id", type: "uuid" });
    expect(r?.column.hints).toContain("PK");
  });

  it("extracts a reference clause", () => {
    const r = __internals.parseColumnLine(
      "profile_id uuid not null references profiles(id)"
    );
    expect(r?.references?.table).toBe("profiles");
    expect(r?.column.hints).toEqual(expect.arrayContaining(["NN", "FK"]));
  });

  it("returns null on non-column lines", () => {
    expect(__internals.parseColumnLine("primary key (user_id, rewo_id)")).toBeNull();
    expect(__internals.parseColumnLine("")).toBeNull();
  });
});
