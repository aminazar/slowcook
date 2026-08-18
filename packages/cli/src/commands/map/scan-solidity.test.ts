// The fs half of Solidity mapping: which files get walked, and how contracts
// survive slicing. Parsing itself is tested in @slowcook-ai/stack-solidity.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { findSolidityFiles, scanSolidityRepo } from "./scan-solidity.js";
import { sliceCodeMap, type CodeMap } from "./scan.js";

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "solmap-"));
  mkdirSync(join(repo, "src/arm-b"), { recursive: true });
  mkdirSync(join(repo, "test"), { recursive: true });
  mkdirSync(join(repo, "lib/forge-std/src"), { recursive: true });
  mkdirSync(join(repo, "out/IouToken.sol"), { recursive: true });

  writeFileSync(
    join(repo, "src/arm-b/IouToken.sol"),
    "interface IIouToken { function mint(address to) external; }\n" +
      "contract IouToken is IIouToken {\n  function mint(address to) external {}\n}\n"
  );
  writeFileSync(join(repo, "test/IouToken.t.sol"), "contract IouTokenTest { function test_x() public {} }\n");
  // Vendored + generated trees must not swamp the map.
  writeFileSync(join(repo, "lib/forge-std/src/Test.sol"), "contract Test { }\n");
  writeFileSync(join(repo, "out/IouToken.sol/IouToken.json"), "{}\n");
  writeFileSync(join(repo, "README.md"), "not solidity\n");
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("findSolidityFiles", () => {
  it("finds project sources and tests", () => {
    const rel = findSolidityFiles(repo).map((f) => f.slice(repo.length + 1));
    expect(rel).toContain("src/arm-b/IouToken.sol");
    expect(rel).toContain("test/IouToken.t.sol");
  });

  it("skips lib/ and out/ — forge-std would swamp the map", () => {
    const rel = findSolidityFiles(repo).map((f) => f.slice(repo.length + 1));
    expect(rel.some((f) => f.startsWith("lib/"))).toBe(false);
    expect(rel.some((f) => f.startsWith("out/"))).toBe(false);
  });

  it("ignores non-.sol files", () => {
    expect(findSolidityFiles(repo).some((f) => f.endsWith(".md"))).toBe(false);
  });
});

describe("scanSolidityRepo", () => {
  it("returns contracts with repo-relative posix paths", () => {
    const found = scanSolidityRepo(repo);
    expect(found.map((c) => c.name).sort()).toEqual(["IIouToken", "IouToken", "IouTokenTest"]);
    expect(found.find((c) => c.name === "IouToken")!.file).toBe("src/arm-b/IouToken.sol");
  });

  it("is empty (not an error) for a repo with no Solidity", () => {
    const empty = mkdtempSync(join(tmpdir(), "nosol-"));
    try {
      expect(scanSolidityRepo(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("sliceCodeMap with contracts", () => {
  const base: CodeMap = {
    schema_version: 1,
    slowcook_version: "test",
    generated_at: "now",
    repo_root: "/r",
    api_routes: [], pages: [], components: [], helpers: [], types: [],
    contracts: [
      { name: "IouToken", kind: "contract", file: "src/IouToken.sol", line: 1, inherits: ["IIouToken"], functions: [], events: [], errors: [], modifiers: [] },
      { name: "IIouToken", kind: "interface", file: "src/IIouToken.sol", line: 1, inherits: [], functions: [], events: [], errors: [], modifiers: [] },
      { name: "Unrelated", kind: "contract", file: "src/Other.sol", line: 1, inherits: [], functions: [], events: [], errors: [], modifiers: [] },
    ],
  };

  it("keeps a contract matched by name and drops unrelated ones", () => {
    const out = sliceCodeMap(base, { names: new Set(["IouToken"]) });
    expect(out.contracts!.map((c) => c.name)).toContain("IouToken");
    expect(out.contracts!.map((c) => c.name)).not.toContain("Unrelated");
  });

  it("keeps a BASE contract in scope — you cannot implement what you cannot see", () => {
    // IIouToken matches neither the file nor the name filter; it survives only
    // because IouToken inherits it.
    const out = sliceCodeMap(base, { files: new Set(["src/IouToken.sol"]) });
    expect(out.contracts!.map((c) => c.name).sort()).toEqual(["IIouToken", "IouToken"]);
  });

  it("leaves contracts absent when the map had none (pure-TS maps unchanged)", () => {
    const ts: CodeMap = { ...base };
    delete ts.contracts;
    expect(sliceCodeMap(ts, { names: new Set(["x"]) }).contracts).toBeUndefined();
  });
});
