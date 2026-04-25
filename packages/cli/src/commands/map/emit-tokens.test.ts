import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitTokensCatalog, parseCssTokens } from "./emit-tokens.js";

function mkRepo(): string {
  return mkdtempSync(join(tmpdir(), "slowcook-emit-tokens-"));
}

describe("parseCssTokens", () => {
  it("extracts :root variables as light variant", () => {
    const css = `
      :root {
        --background: #FAF5F0;
        --coral: #FF6B6B;
      }
    `;
    const out = parseCssTokens(css, "globals.css");
    expect(out.light).toHaveLength(2);
    expect(out.light[0]).toMatchObject({
      name: "--background",
      value: "#FAF5F0",
      variant: "light",
    });
    expect(out.dark).toHaveLength(0);
    expect(out.themeMappings).toHaveLength(0);
  });

  it("routes :root inside @media (prefers-color-scheme: dark) to dark variant", () => {
    const css = `
      :root {
        --background: #ffffff;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --background: #0f0f18;
        }
      }
    `;
    const out = parseCssTokens(css, "globals.css");
    expect(out.light).toHaveLength(1);
    expect(out.light[0]!.value).toBe("#ffffff");
    expect(out.dark).toHaveLength(1);
    expect(out.dark[0]!.value).toBe("#0f0f18");
    expect(out.dark[0]!.variant).toBe("dark");
  });

  it("captures @theme block as themeMappings (Tailwind v4)", () => {
    const css = `
      @theme inline {
        --color-coral: var(--coral);
        --font-sans: var(--font-jakarta);
      }
    `;
    const out = parseCssTokens(css, "globals.css");
    expect(out.themeMappings).toHaveLength(2);
    expect(out.themeMappings[0]!.name).toBe("--color-coral");
    expect(out.themeMappings[1]!.name).toBe("--font-sans");
  });

  it("does not lose top-level :root after a bodyless at-rule like @import (Tailwind v4 idiom)", () => {
    // Regression: parser used to glue `@import "tailwindcss";` onto the
    // following `:root` head and drop all light-variant tokens.
    const css = `
@import "tailwindcss";

:root {
  --background: #FAF5F0;
  --coral: #FF6B6B;
}

@media (prefers-color-scheme: dark) {
  :root {
    --background: #0f0f18;
  }
}
`;
    const out = parseCssTokens(css, "globals.css");
    expect(out.light).toHaveLength(2);
    expect(out.light[0]!.name).toBe("--background");
    expect(out.light[0]!.value).toBe("#FAF5F0");
    expect(out.dark).toHaveLength(1);
    expect(out.dark[0]!.value).toBe("#0f0f18");
  });

  it("ignores comments and other selectors", () => {
    const css = `
      /* leading comment */
      body { color: red; }
      :root {
        /* core */
        --foo: 1px;
      }
      .ignored { background: blue; }
    `;
    const out = parseCssTokens(css, "f.css");
    expect(out.light).toHaveLength(1);
    expect(out.light[0]!.name).toBe("--foo");
  });
});

describe("emitTokensCatalog", () => {
  it("skips when no .css files exist", () => {
    const repo = mkRepo();
    try {
      const result = emitTokensCatalog(repo);
      expect(result.written).toBe(false);
      expect(result.filesScanned).toBe(0);
      expect(result.skippedReason).toContain("no .css files");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("skips when .css files have no :root or @theme blocks", () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(
        join(repo, "src/style.css"),
        `body { color: red; }\n.foo { padding: 4px; }\n`,
        "utf8"
      );
      const result = emitTokensCatalog(repo);
      expect(result.written).toBe(false);
      expect(result.filesScanned).toBe(1);
      expect(result.skippedReason).toContain("no :root or @theme");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("writes tokens.md with light/dark/theme sections and color classification", () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, "src/app"), { recursive: true });
      writeFileSync(
        join(repo, "src/app/globals.css"),
        `:root {
  --background: #FAF5F0;
  --coral: #FF6B6B;
  --font-sans: "Inter";
  --radius: 8px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --background: #0f0f18;
  }
}
@theme inline {
  --color-coral: var(--coral);
}
`,
        "utf8"
      );
      const result = emitTokensCatalog(repo);
      expect(result.written).toBe(true);
      expect(result.lightCount).toBe(4);
      expect(result.darkCount).toBe(1);
      expect(result.themeCount).toBe(1);

      const out = readFileSync(
        join(repo, ".brewing/diagrams/tokens.md"),
        "utf8"
      );
      expect(out).toContain("Auto-emitted by");
      expect(out).toContain("Light variant");
      expect(out).toContain("Dark variant");
      expect(out).toContain("Theme mappings");
      expect(out).toContain("`--background`");
      expect(out).toContain("`--coral`");
      // Classification: --coral is a hex → color section
      expect(out).toMatch(/### color[\s\S]+--coral/);
      // --font-sans → typography section
      expect(out).toMatch(/### typography[\s\S]+--font-sans/);
      // --radius → spacing section
      expect(out).toMatch(/### spacing[\s\S]+--radius/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("walks subdirectories but skips node_modules / .next / .open-next / dist", () => {
    const repo = mkRepo();
    try {
      // Should be picked up.
      mkdirSync(join(repo, "src/app"), { recursive: true });
      writeFileSync(
        join(repo, "src/app/globals.css"),
        `:root { --kept: #fff; }\n`,
        "utf8"
      );
      // Should be skipped.
      for (const skip of ["node_modules", ".next", ".open-next", "dist"]) {
        mkdirSync(join(repo, skip), { recursive: true });
        writeFileSync(
          join(repo, skip, "junk.css"),
          `:root { --leak: red; }\n`,
          "utf8"
        );
      }
      const result = emitTokensCatalog(repo);
      expect(result.written).toBe(true);
      expect(result.filesScanned).toBe(1);
      expect(result.lightCount).toBe(1);
      const out = readFileSync(
        join(repo, ".brewing/diagrams/tokens.md"),
        "utf8"
      );
      expect(out).toContain("--kept");
      expect(out).not.toContain("--leak");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
