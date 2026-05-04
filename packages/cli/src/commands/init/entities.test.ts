import { describe, it, expect } from "vitest";
import { __internals } from "./entities.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { pgTypeToTsAndZod, pascalCase, renderEntityFile, renderIndexFile, decideAction, PROTECTED_MARKER } = __internals;

describe("pgTypeToTsAndZod", () => {
  it("maps uuid to z.string().uuid()", () => {
    expect(pgTypeToTsAndZod("uuid")).toEqual({ ts: "string", zod: "z.string().uuid()" });
  });
  it("maps text to z.string()", () => {
    expect(pgTypeToTsAndZod("text")).toEqual({ ts: "string", zod: "z.string()" });
  });
  it("maps int to z.number().int()", () => {
    expect(pgTypeToTsAndZod("int")).toEqual({ ts: "number", zod: "z.number().int()" });
  });
  it("maps unknown to z.unknown()", () => {
    expect(pgTypeToTsAndZod("phantom")).toEqual({ ts: "unknown", zod: "z.unknown()" });
  });
});

describe("pascalCase", () => {
  it("converts snake_case to PascalCase", () => {
    expect(pascalCase("rewo_reactions")).toBe("RewoReactions");
    expect(pascalCase("profiles")).toBe("Profiles");
    expect(pascalCase("invite_codes")).toBe("InviteCodes");
  });
});

describe("renderEntityFile", () => {
  it("renders a complete entity file with interface + schema", () => {
    const out = renderEntityFile({
      entity: {
        name: "profiles",
        columns: [
          { name: "id", type: "uuid", hints: ["PK", "NN"] },
          { name: "handle", type: "text", hints: ["NN"] },
          { name: "bio", type: "text", hints: [] },
        ],
      },
      sourceMigrations: ["00001_init.sql"],
      fkRefs: [],
    });
    expect(out).toContain("export interface Profiles {");
    expect(out).toContain("  id: string; /** PK */");
    expect(out).toContain("  handle: string;");
    expect(out).toContain("  bio: string | null;");
    expect(out).toContain("export const ProfilesSchema = z.object({");
    expect(out).toContain("  id: z.string().uuid(),");
    expect(out).toContain("  handle: z.string(),");
    expect(out).toContain("  bio: z.string().nullable(),");
    expect(out).toContain("00001_init.sql");
    expect(out).toContain('import { z } from "zod"');
  });

  it("documents foreign-key refs in the JSDoc", () => {
    const out = renderEntityFile({
      entity: { name: "rewos", columns: [{ name: "id", type: "uuid", hints: ["PK"] }] },
      sourceMigrations: ["00001.sql"],
      fkRefs: [{ col: "member_id", refsTable: "profiles" }],
    });
    expect(out).toContain("Foreign keys:");
    expect(out).toContain("member_id → profiles");
  });
});

describe("renderIndexFile", () => {
  it("re-exports each entity file via the .js extension", () => {
    const out = renderIndexFile(["profiles", "rewos", "reactions"]);
    expect(out).toContain('export * from "./profiles.js";');
    expect(out).toContain('export * from "./rewos.js";');
    expect(out).toContain('export * from "./reactions.js";');
  });
});

describe("decideAction (idempotency + protection)", () => {
  it("returns 'create' when file does not exist", () => {
    const r = mkdtempSync(join(tmpdir(), "entities-act-"));
    try {
      expect(decideAction(join(r, "missing.ts"), "anything")).toBe("create");
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it("returns 'skip-identical' when content matches", () => {
    const r = mkdtempSync(join(tmpdir(), "entities-act-"));
    try {
      const path = join(r, "same.ts");
      writeFileSync(path, "hello", "utf8");
      expect(decideAction(path, "hello")).toBe("skip-identical");
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it("returns 'update' when content differs", () => {
    const r = mkdtempSync(join(tmpdir(), "entities-act-"));
    try {
      const path = join(r, "diff.ts");
      writeFileSync(path, "old", "utf8");
      expect(decideAction(path, "new")).toBe("update");
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it("respects @slowcook-entity-protected marker", () => {
    const r = mkdtempSync(join(tmpdir(), "entities-act-"));
    try {
      const path = join(r, "protected.ts");
      writeFileSync(path, `${PROTECTED_MARKER}\nhand-edited`, "utf8");
      expect(decideAction(path, "regenerated content")).toBe("skip-protected");
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});
