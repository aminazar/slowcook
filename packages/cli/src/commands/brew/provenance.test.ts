import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyBrewEntry,
  readProvenance,
  writeProvenance,
  recordBrewProvenance,
  PROVENANCE_PATH,
  PROVENANCE_SCHEMA_VERSION,
  type ProvenanceIndex,
  type BrewProvenanceEntry,
} from "./provenance.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "slowcook-prov-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const baseEntry: BrewProvenanceEntry = {
  story_id: "story-005",
  pr_url: "https://github.com/x/y/pull/43",
  completed_at: "2026-04-25T10:00:00Z",
  files_touched: ["src/components/x.tsx"],
  regression_count: 0,
  halted: false,
};

describe("readProvenance", () => {
  it("returns a fresh empty index when the file is missing", () => {
    const index = readProvenance(tmp);
    expect(index.schema_version).toBe(PROVENANCE_SCHEMA_VERSION);
    expect(index.by_file).toEqual({});
    expect(index.by_symbol).toEqual({});
    expect(index.by_route).toEqual({});
  });

  it("reads an existing file at .brewing/provenance.json", () => {
    mkdirSync(join(tmp, ".brewing"), { recursive: true });
    writeFileSync(
      join(tmp, PROVENANCE_PATH),
      JSON.stringify({
        schema_version: 1,
        by_file: {
          "src/x.ts": {
            first_added_by: "story-001",
            modified_by: ["story-001"],
            last_brew: "story-001",
            last_pr: "https://x/1",
            last_modified: "2026-04-20T00:00:00Z",
            halt_count: 0,
            regression_count: 0,
          },
        },
        by_symbol: {},
        by_route: {},
      }) + "\n"
    );
    const index = readProvenance(tmp);
    expect(Object.keys(index.by_file)).toEqual(["src/x.ts"]);
    expect(index.by_file["src/x.ts"]?.first_added_by).toBe("story-001");
  });

  it("starts fresh on schema-version mismatch (forward-compat)", () => {
    mkdirSync(join(tmp, ".brewing"), { recursive: true });
    writeFileSync(
      join(tmp, PROVENANCE_PATH),
      JSON.stringify({ schema_version: 99, by_file: { "x": {} } })
    );
    const index = readProvenance(tmp);
    expect(index.schema_version).toBe(PROVENANCE_SCHEMA_VERSION);
    expect(index.by_file).toEqual({});
  });

  it("returns empty on corrupt JSON instead of throwing", () => {
    mkdirSync(join(tmp, ".brewing"), { recursive: true });
    writeFileSync(join(tmp, PROVENANCE_PATH), "{ not valid json");
    const index = readProvenance(tmp);
    expect(index.by_file).toEqual({});
  });
});

describe("applyBrewEntry — by_file", () => {
  it("creates a new entry when file is unseen", () => {
    const empty: ProvenanceIndex = {
      schema_version: 1,
      by_file: {},
      by_symbol: {},
      by_route: {},
    };
    const next = applyBrewEntry(empty, baseEntry);
    expect(next.by_file["src/components/x.tsx"]).toMatchObject({
      first_added_by: "story-005",
      modified_by: ["story-005"],
      last_brew: "story-005",
      halt_count: 0,
      regression_count: 0,
    });
  });

  it("appends story to modified_by; keeps first_added_by stable", () => {
    let index: ProvenanceIndex = {
      schema_version: 1,
      by_file: {},
      by_symbol: {},
      by_route: {},
    };
    index = applyBrewEntry(index, { ...baseEntry, story_id: "story-005" });
    index = applyBrewEntry(index, {
      ...baseEntry,
      story_id: "story-010",
      completed_at: "2026-04-26T00:00:00Z",
    });
    const fp = index.by_file["src/components/x.tsx"];
    expect(fp?.first_added_by).toBe("story-005");
    expect(fp?.modified_by).toEqual(["story-005", "story-010"]);
    expect(fp?.last_brew).toBe("story-010");
    expect(fp?.last_modified).toBe("2026-04-26T00:00:00Z");
  });

  it("dedupes story_id in modified_by when same story brews same file twice", () => {
    let index: ProvenanceIndex = {
      schema_version: 1,
      by_file: {},
      by_symbol: {},
      by_route: {},
    };
    index = applyBrewEntry(index, baseEntry);
    index = applyBrewEntry(index, baseEntry);
    expect(index.by_file["src/components/x.tsx"]?.modified_by).toEqual(["story-005"]);
  });

  it("accumulates halt_count and regression_count", () => {
    let index: ProvenanceIndex = {
      schema_version: 1,
      by_file: {},
      by_symbol: {},
      by_route: {},
    };
    index = applyBrewEntry(index, { ...baseEntry, halted: true, regression_count: 2 });
    index = applyBrewEntry(index, {
      ...baseEntry,
      story_id: "story-006",
      halted: false,
      regression_count: 1,
    });
    const fp = index.by_file["src/components/x.tsx"];
    expect(fp?.halt_count).toBe(1);
    expect(fp?.regression_count).toBe(3);
  });
});

describe("applyBrewEntry — by_symbol and by_route (optional)", () => {
  it("captures new symbols when supplied", () => {
    const empty: ProvenanceIndex = {
      schema_version: 1,
      by_file: {},
      by_symbol: {},
      by_route: {},
    };
    const next = applyBrewEntry(empty, {
      ...baseEntry,
      symbols_added: [
        { name: "MemberReactionsPage", file: "src/x.tsx", kind: "component" },
      ],
    });
    expect(next.by_symbol["MemberReactionsPage"]).toMatchObject({
      file: "src/x.tsx",
      kind: "component",
      added_by: "story-005",
      modified_by: ["story-005"],
    });
  });

  it("captures routes when supplied", () => {
    const empty: ProvenanceIndex = {
      schema_version: 1,
      by_file: {},
      by_symbol: {},
      by_route: {},
    };
    const next = applyBrewEntry(empty, {
      ...baseEntry,
      routes_added: [
        { path: "/u/[handle]", file: "src/app/(main)/u/[handle]/page.tsx" },
      ],
    });
    expect(next.by_route["/u/[handle]"]).toMatchObject({
      stories: ["story-005"],
      current_file: "src/app/(main)/u/[handle]/page.tsx",
    });
  });

  it("is a no-op when symbols/routes aren't supplied", () => {
    const empty: ProvenanceIndex = {
      schema_version: 1,
      by_file: {},
      by_symbol: {},
      by_route: {},
    };
    const next = applyBrewEntry(empty, baseEntry);
    expect(next.by_symbol).toEqual({});
    expect(next.by_route).toEqual({});
  });
});

describe("writeProvenance + recordBrewProvenance", () => {
  it("writes the file with sorted-ish JSON", () => {
    writeProvenance(tmp, {
      schema_version: 1,
      by_file: {},
      by_symbol: {},
      by_route: {},
    });
    expect(existsSync(join(tmp, PROVENANCE_PATH))).toBe(true);
    const text = readFileSync(join(tmp, PROVENANCE_PATH), "utf8");
    expect(text).toContain('"schema_version": 1');
    expect(text.endsWith("\n")).toBe(true);
  });

  it("recordBrewProvenance reads, applies, writes in one call", () => {
    recordBrewProvenance(tmp, baseEntry);
    const written = JSON.parse(readFileSync(join(tmp, PROVENANCE_PATH), "utf8"));
    expect(written.by_file["src/components/x.tsx"]?.first_added_by).toBe("story-005");
  });

  it("multiple records accumulate correctly via the public API", () => {
    recordBrewProvenance(tmp, baseEntry);
    recordBrewProvenance(tmp, {
      ...baseEntry,
      story_id: "story-006",
      files_touched: ["src/components/x.tsx", "src/lib/y.ts"],
    });
    const written = JSON.parse(readFileSync(join(tmp, PROVENANCE_PATH), "utf8"));
    expect(written.by_file["src/components/x.tsx"]?.modified_by).toEqual([
      "story-005",
      "story-006",
    ]);
    expect(written.by_file["src/lib/y.ts"]?.first_added_by).toBe("story-006");
  });
});
