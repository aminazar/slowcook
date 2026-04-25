import { describe, it, expect } from "vitest";
import {
  parseTestFileBlock,
  hasTestFileBlock,
  parseHalt,
} from "./agent.js";

describe("parseTestFileBlock", () => {
  it("extracts the body of a <test_file> block", () => {
    const text = `
Some preamble.

<test_file>
import { describe, it, expect } from "vitest";

describe("B-1 regression", () => {
  it("works", () => {
    expect(true).toBe(true);
  });
});
</test_file>

trailing.
`;
    const body = parseTestFileBlock(text);
    expect(body).toContain('import { describe, it, expect } from "vitest"');
    expect(body).toContain("describe(");
    expect(body?.endsWith("\n")).toBe(true);
  });

  it("strips ```ts code fences inside the block (LLM common habit)", () => {
    const text = `
<test_file>
\`\`\`ts
import { describe, it, expect } from "vitest";

describe("B-2", () => {
  it("works", () => { expect(1).toBe(1); });
});
\`\`\`
</test_file>
`;
    const body = parseTestFileBlock(text);
    expect(body).not.toContain("```ts");
    expect(body).not.toContain("```");
    expect(body).toContain("import");
  });

  it("strips ```typescript fences too", () => {
    const text = `<test_file>\n\`\`\`typescript\nconst x = 1;\n\`\`\`\n</test_file>`;
    const body = parseTestFileBlock(text);
    expect(body).toBe("const x = 1;\n");
  });

  it("returns null when no <test_file> block is present", () => {
    expect(parseTestFileBlock("just chatter")).toBeNull();
  });

  it("returns null when the block is empty", () => {
    expect(parseTestFileBlock("<test_file></test_file>")).toBeNull();
  });
});

describe("hasTestFileBlock", () => {
  it("returns true when the block is present", () => {
    expect(hasTestFileBlock("<test_file>x</test_file>")).toBe(true);
  });
  it("returns false when absent", () => {
    expect(hasTestFileBlock("plain text")).toBe(false);
  });
  it("returns false when only the opening tag is present", () => {
    expect(hasTestFileBlock("<test_file>incomplete")).toBe(false);
  });
});

describe("parseHalt", () => {
  it("extracts the reason from the structured form", () => {
    const text = `<halt><reason>cannot deterministically reproduce</reason></halt>`;
    expect(parseHalt(text)).toBe("cannot deterministically reproduce");
  });
  it("falls back to bare <halt>X</halt>", () => {
    expect(parseHalt("<halt>just stuck</halt>")).toBe("just stuck");
  });
  it("returns null when there's no halt block", () => {
    expect(parseHalt("plain text")).toBeNull();
  });
});
