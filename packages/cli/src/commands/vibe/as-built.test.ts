// #263 — as-built vibe: faithful mock from production source, provenance-
// stamped, surface-dir-confined; violations reject the whole output.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmClient, LlmResponse } from "@slowcook-ai/core";
import { collectAsBuiltInput, runAsBuiltVibe, buildAsBuiltVibePrompt } from "./as-built.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sc-abv-"));
  mkdirSync(join(root, "src/components"), { recursive: true });
  mkdirSync(join(root, ".brewing"), { recursive: true });
  writeFileSync(join(root, "src/components/Wallet.tsx"), `import { helper } from "./wallet-utils";\nexport const Wallet = () => <div>balance</div>;\n`);
  writeFileSync(join(root, "src/components/wallet-utils.ts"), `export const helper = 1;\n`);
  writeFileSync(join(root, ".brewing/brand.yaml"), "palette:\n  coral: '#FF6B6B'\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const fakeLlm = (text: string): LlmClient => ({
  async complete(): Promise<LlmResponse> {
    return { text, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } } as unknown as LlmResponse;
  },
} as unknown as LlmClient);

describe("vibe --as-built", () => {
  it("collects the source + one-hop local imports + brand tokens into the prompt", () => {
    const input = collectAsBuiltInput(root, "src/components/Wallet.tsx");
    expect(input.surface).toBe("wallet");
    expect(input.sources.map((s) => s.path)).toEqual(["src/components/Wallet.tsx", "src/components/wallet-utils.ts"]);
    const prompt = buildAsBuiltVibePrompt(input);
    expect(prompt).toContain("Target directory for ALL files: mock/src/apps/wallet/");
    expect(prompt).toContain("#FF6B6B");
  });

  it("writes stamped files confined to the surface dir", async () => {
    const good = `<file path="mock/src/apps/wallet/Wallet.tsx">// @slowcook-as-built-from src/components/Wallet.tsx@abc — prod-first: this mock\n// mirrors production; edits here are PROPOSALS, not truth.\nexport const Wallet = () => <div>balance</div>;\n</file>`;
    const input = collectAsBuiltInput(root, "src/components/Wallet.tsx");
    const r = await runAsBuiltVibe(fakeLlm(good), "m", input);
    expect(r.violations).toEqual([]);
    expect(r.written).toEqual(["mock/src/apps/wallet/Wallet.tsx"]);
    expect(readFileSync(join(root, "mock/src/apps/wallet/Wallet.tsx"), "utf8")).toContain("@slowcook-as-built-from");
  });

  it("rejects missing provenance stamps and out-of-surface paths — nothing written", async () => {
    const bad = `<file path="mock/src/apps/other/X.tsx">export const X = 1;\n</file>`;
    const input = collectAsBuiltInput(root, "src/components/Wallet.tsx");
    const r = await runAsBuiltVibe(fakeLlm(bad), "m", input);
    expect(r.violations.length).toBe(2); // no stamp + wrong dir
    expect(r.written).toEqual([]);
    expect(existsSync(join(root, "mock/src/apps/other/X.tsx"))).toBe(false);
  });
});
