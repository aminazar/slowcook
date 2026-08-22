import { describe, it, expect } from "vitest";
import { ddlToMermaidErd, ddlFunctions } from "./mermaid.js";

describe("schema extract reflects reality (brownfield provision, 2026-08-22)", () => {
  const DDL = `
create table member_rewos ( id uuid primary key, member_id uuid references profiles(id) );
create table rewo_reactions ( id uuid primary key, rewo_id uuid references rewos(id) );
CREATE OR REPLACE FUNCTION merge_rewos(from_id uuid, to_id uuid)
RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql SECURITY DEFINER;
CREATE FUNCTION helper_fn() RETURNS int AS $$ select 1 $$ LANGUAGE sql;
DROP FUNCTION helper_fn;
DROP TABLE member_rewos;
`;

  it("a dropped table leaves the diagram (rewo's member_rewos ghost)", () => {
    const erd = ddlToMermaidErd(DDL);
    expect(erd).not.toContain("MEMBER_REWOS");
    expect(erd).toContain("REWO_REACTIONS");
  });

  it("functions are extracted with signature and definer; drops honored", () => {
    const fns = ddlFunctions(DDL);
    expect(fns).toHaveLength(1);
    expect(fns[0]).toMatchObject({ name: "merge_rewos", definer: true });
    expect(fns[0]!.args).toContain("from_id uuid");
  });

  it("rename moves the entity", () => {
    const erd = ddlToMermaidErd(
      "create table old_name ( id uuid primary key );\nalter table old_name rename to new_name;"
    );
    expect(erd).not.toContain("OLD_NAME");
    expect(erd).toContain("NEW_NAME");
  });
});
