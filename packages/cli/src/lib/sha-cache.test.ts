import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheKey, memoBySha, treeFingerprint, CACHE_ROOT_REL, describeMemo, isFingerprintExcluded } from "./sha-cache.js";

function fakeGit(state: { head: string; status: string; diff?: string }) {
  return (cmd: string): string => {
    if (cmd.startsWith("git rev-parse")) return state.head + "\n";
    if (cmd.startsWith("git status")) return state.status;
    if (cmd.startsWith("git diff")) return state.diff ?? "";
    throw new Error(`unexpected ${cmd}`);
  };
}

describe("sha-keyed cache (WP4)", () => {
  it("fingerprint: clean tree is 'clean'; dirt changes the fingerprint; key changes with name/version/sha/dirt", () => {
    const root = mkdtempSync(join(tmpdir(), "shacache-"));
    const clean = treeFingerprint(root, fakeGit({ head: "abc", status: "" }));
    expect(clean).toEqual({ head_sha: "abc", dirty: "clean" });
    // slowcook's own artifacts are never dirt (the producer's report must not invalidate the producer)
    expect(treeFingerprint(root, fakeGit({ head: "abc", status: "?? .brewing/recon/story-026.json\0?? mock/.brewing/x.json\0" }))).toEqual({ head_sha: "abc", dirty: "clean" });
    expect(isFingerprintExcluded(".brewing/local/cache/a.json")).toBe(true);
    expect(isFingerprintExcluded("src/.brewing-ish.ts")).toBe(false);
    const d1 = treeFingerprint(root, fakeGit({ head: "abc", status: " M src/a.ts\0", diff: "-x\n+y" }));
    const d2 = treeFingerprint(root, fakeGit({ head: "abc", status: " M src/a.ts\0", diff: "-x\n+z" }));
    expect(d1.dirty).not.toBe("clean");
    expect(d1.dirty).not.toBe(d2.dirty);
    const k = cacheKey("history-index", "1", clean);
    expect(cacheKey("history-index", "2", clean)).not.toBe(k);
    expect(cacheKey("code-map", "1", clean)).not.toBe(k);
    expect(cacheKey("history-index", "1", { head_sha: "def", dirty: "clean" })).not.toBe(k);
    expect(cacheKey("history-index", "1", d1)).not.toBe(k);
  });

  it("memo: builds once per key, hits after, misses on a new sha or version, counts hits, prunes", () => {
    const root = mkdtempSync(join(tmpdir(), "shacache-"));
    let builds = 0;
    const build = () => ({ n: ++builds });
    const at = (head: string, version = "1") =>
      memoBySha({ repoRoot: root, name: "thing", version, build, exec: fakeGit({ head, status: "" }), env: {}, maxEntries: 2 });
    const a = at("aaa");
    expect(a).toMatchObject({ value: { n: 1 }, hit: false });
    expect(a.receipt).toMatchObject({ name: "thing", head_sha: "aaa", dirty: "clean", hits: 0 });
    const b = at("aaa");
    expect(b).toMatchObject({ value: { n: 1 }, hit: true });
    expect(b.receipt?.hits).toBe(1);
    expect(at("aaa").receipt?.hits).toBe(2);
    expect(at("bbb")).toMatchObject({ value: { n: 2 }, hit: false });
    expect(at("aaa", "2")).toMatchObject({ value: { n: 3 }, hit: false });
    expect(builds).toBe(3);
    // maxEntries 2 → the oldest of the three keys is gone
    expect(readdirSync(join(root, CACHE_ROOT_REL, "thing")).length).toBe(2);
    expect(describeMemo("thing", b)).toMatch(/cache hit @aaa/);
  });

  it("SLOWCOOK_NO_CACHE bypasses; no git degrades to a plain build; a corrupt entry is rebuilt", () => {
    const root = mkdtempSync(join(tmpdir(), "shacache-"));
    let builds = 0;
    const build = () => ++builds;
    expect(memoBySha({ repoRoot: root, name: "x", version: "1", build, exec: fakeGit({ head: "a", status: "" }), env: { SLOWCOOK_NO_CACHE: "1" } })).toMatchObject({ value: 1, hit: false, receipt: null });
    expect(memoBySha({ repoRoot: root, name: "x", version: "1", build, exec: () => { throw new Error("not a git repo"); }, env: {} })).toMatchObject({ value: 2, hit: false, receipt: null });
    const first = memoBySha({ repoRoot: root, name: "x", version: "1", build, exec: fakeGit({ head: "a", status: "" }), env: {} });
    expect(first.hit).toBe(false);
    writeFileSync(join(root, CACHE_ROOT_REL, "x", `${first.receipt!.key}.json`), "{not json", "utf8");
    const again = memoBySha({ repoRoot: root, name: "x", version: "1", build, exec: fakeGit({ head: "a", status: "" }), env: {} });
    expect(again).toMatchObject({ value: 4, hit: false });
  });
});
