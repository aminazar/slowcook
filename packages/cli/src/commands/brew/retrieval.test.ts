import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findReferences,
  findImplementations,
  findDefinition,
  renderReferences,
} from "./retrieval.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "slowcook-retrieve-"));
  mkdirSync(join(tmp, "src"), { recursive: true });
  mkdirSync(join(tmp, "src", "lib"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, contents: string): void {
  const full = join(tmp, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

describe("findReferences", () => {
  it("returns empty array when src/ doesn't exist", () => {
    rmSync(join(tmp, "src"), { recursive: true, force: true });
    expect(findReferences(tmp, "anything")).toEqual([]);
  });

  it("finds identifier references across files", () => {
    write(
      "src/lib/data.ts",
      `export function getProfileByHandle(handle: string) {
  return null;
}
`
    );
    write(
      "src/app/page.tsx",
      `import { getProfileByHandle } from "@/lib/data";

export default function Page() {
  const p = getProfileByHandle("amin");
  return null;
}
`
    );
    const refs = findReferences(tmp, "getProfileByHandle");
    expect(refs.length).toBeGreaterThanOrEqual(2);
    const kinds = refs.map((r) => r.kind);
    expect(kinds).toContain("definition");
    expect(kinds).toContain("import");
    expect(kinds).toContain("reference");
  });

  it("ignores identifier-shaped tokens inside strings and comments", () => {
    write(
      "src/file.ts",
      `// FooBar in a comment
const s = "FooBar in a string literal";
function FooBar() { return 1; }
const x = FooBar();
`
    );
    const refs = findReferences(tmp, "FooBar");
    expect(refs.length).toBe(2); // definition + reference; NOT comment or string
    const lines = refs.map((r) => r.context);
    expect(lines.some((l) => l.includes("comment"))).toBe(false);
    expect(lines.some((l) => l.includes("string literal"))).toBe(false);
  });

  it("excludes definitions when option is set", () => {
    write(
      "src/file.ts",
      `function Foo() { return 1; }
const x = Foo();
`
    );
    const refs = findReferences(tmp, "Foo", { excludeDefinitions: true });
    expect(refs.every((r) => r.kind !== "definition")).toBe(true);
  });

  it("respects maxResults cap", () => {
    write(
      "src/file.ts",
      Array.from({ length: 50 }, (_, i) => `const x${i} = SomeFn();`).join("\n") +
        "\nfunction SomeFn() { return 1; }"
    );
    const refs = findReferences(tmp, "SomeFn", { maxResults: 10 });
    expect(refs.length).toBe(10);
  });
});

describe("findImplementations", () => {
  it("finds classes implementing an interface", () => {
    write(
      "src/iface.ts",
      `export interface Greeter { hello(): string; }
`
    );
    write(
      "src/impl.ts",
      `import type { Greeter } from "./iface";
export class English implements Greeter { hello() { return "hi"; } }
`
    );
    const impls = findImplementations(tmp, "Greeter");
    expect(impls.length).toBe(1);
    expect(impls[0]?.kind).toBe("implements");
    expect(impls[0]?.context).toContain("English");
  });

  it("finds interfaces extending another interface", () => {
    write(
      "src/iface.ts",
      `export interface Base {}
export interface Derived extends Base {}
`
    );
    const exts = findImplementations(tmp, "Base");
    expect(exts.length).toBe(1);
    expect(exts[0]?.kind).toBe("extends");
  });

  it("finds class extends class", () => {
    write(
      "src/cls.ts",
      `class Animal {}
class Dog extends Animal {}
`
    );
    const exts = findImplementations(tmp, "Animal");
    expect(exts.length).toBe(1);
    expect(exts[0]?.kind).toBe("extends");
  });
});

describe("findDefinition", () => {
  it("returns the first declaration of a function", () => {
    write(
      "src/lib.ts",
      `function helperA() {}
export function getProfileByHandle(handle: string) { return null; }
`
    );
    const def = findDefinition(tmp, "getProfileByHandle");
    expect(def).not.toBeNull();
    expect(def?.kind).toBe("definition");
    expect(def?.file).toBe("src/lib.ts");
  });

  it("returns null when the symbol isn't declared anywhere", () => {
    write("src/lib.ts", `export function foo() {}`);
    expect(findDefinition(tmp, "doesNotExist")).toBeNull();
  });

  it("works for interfaces, types, classes, enums", () => {
    write(
      "src/types.ts",
      `export interface MyInterface { x: number; }
export type MyType = string;
export class MyClass {}
export enum MyEnum { A, B }
`
    );
    expect(findDefinition(tmp, "MyInterface")?.kind).toBe("definition");
    expect(findDefinition(tmp, "MyType")?.kind).toBe("definition");
    expect(findDefinition(tmp, "MyClass")?.kind).toBe("definition");
    expect(findDefinition(tmp, "MyEnum")?.kind).toBe("definition");
  });
});

describe("renderReferences", () => {
  it("returns a placeholder when refs is empty", () => {
    expect(renderReferences([])).toBe("(no references found)");
  });

  it("renders one line per reference with kind padding", () => {
    const refs = [
      {
        file: "src/x.ts",
        line: 1,
        column: 1,
        context: "function foo() {}",
        kind: "definition" as const,
      },
      {
        file: "src/y.ts",
        line: 2,
        column: 5,
        context: "foo()",
        kind: "reference" as const,
      },
    ];
    const out = renderReferences(refs);
    expect(out).toContain("definition");
    expect(out).toContain("src/x.ts:1:1");
    expect(out).toContain("reference");
    expect(out).toContain("src/y.ts:2:5");
  });

  it("truncates above the max", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      file: "src/x.ts",
      line: i + 1,
      column: 1,
      context: "x",
      kind: "reference" as const,
    }));
    const out = renderReferences(many, 5);
    expect(out).toContain("(45 more truncated)");
  });
});
