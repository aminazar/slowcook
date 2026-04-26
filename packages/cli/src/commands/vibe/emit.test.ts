import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseVibeOutput,
  writeVibeFiles,
  validateAndResolveVibePath,
} from "./emit.js";

function mkRepo(): string {
  return mkdtempSync(join(tmpdir(), "slowcook-vibe-emit-"));
}

describe("parseVibeOutput", () => {
  it("extracts <file> blocks with path + contents", () => {
    const body = `before
<file path="src/app/page.tsx">
export default function Page() { return <div>hi</div>; }
</file>
between
<file path="src/lib/data/notifications.mock.ts">
export const list = [];
</file>
after`;
    const out = parseVibeOutput(body);
    expect(out.files).toHaveLength(2);
    expect(out.files[0]!.path).toBe("src/app/page.tsx");
    expect(out.files[0]!.contents).toContain("export default function Page");
    expect(out.files[0]!.contents.endsWith("\n")).toBe(true);
    expect(out.files[1]!.path).toBe("src/lib/data/notifications.mock.ts");
    expect(out.files[1]!.contents).toContain("export const list = []");
  });

  it("extracts <component_change_request> blocks separately", () => {
    const body = `<component_change_request component="RewoCard" path="src/components/rewo/rewo-card.tsx">
RewoCard needs an onPin prop. Recommended: optional onPin?: () => void.
</component_change_request>`;
    const out = parseVibeOutput(body);
    expect(out.files).toHaveLength(0);
    expect(out.changeRequests).toHaveLength(1);
    expect(out.changeRequests[0]).toMatchObject({
      component: "RewoCard",
      path: "src/components/rewo/rewo-card.tsx",
    });
    expect(out.changeRequests[0]!.rationale).toContain("onPin prop");
  });

  it("returns empty arrays for prose with no blocks", () => {
    const out = parseVibeOutput("just some prose, no XML");
    expect(out.files).toEqual([]);
    expect(out.changeRequests).toEqual([]);
  });

  it("handles a complete realistic emit (page + component + mock + stub + change-request)", () => {
    const body = `<file path="src/app/(main)/notifications/page.tsx">
import { NotificationsList } from "@/components/notifications/notifications-list";
import { list } from "@/lib/data/notifications";

export default function NotificationsPage() {
  return <NotificationsList initialItems={list} />;
}
</file>
<file path="src/components/notifications/notifications-list.tsx">
"use client";
import { useState } from "react";
export function NotificationsList({ initialItems }) { return null; }
</file>
<file path="src/lib/data/notifications.mock.ts">
export const list = [{ id: "n-1" }];
</file>
<file path="src/lib/data/notifications.ts">
export * from "./notifications.mock.js";
</file>
<component_change_request component="NavLink" path="src/components/ui/nav-link.tsx">
Needs an unreadBadge prop.
</component_change_request>`;
    const out = parseVibeOutput(body);
    expect(out.files).toHaveLength(4);
    expect(out.files.map((f) => f.path)).toEqual([
      "src/app/(main)/notifications/page.tsx",
      "src/components/notifications/notifications-list.tsx",
      "src/lib/data/notifications.mock.ts",
      "src/lib/data/notifications.ts",
    ]);
    expect(out.changeRequests).toHaveLength(1);
  });
});

describe("validateAndResolveVibePath", () => {
  const root = "/tmp/repo";

  it("accepts a normal mock/ path", () => {
    const p = validateAndResolveVibePath(root, "mock/src/components/Foo.tsx");
    expect(p).toBe("/tmp/repo/mock/src/components/Foo.tsx");
  });

  it("0.16.0-α.4: rejects writes outside mock/", () => {
    expect(() =>
      validateAndResolveVibePath(root, "src/components/Foo.tsx")
    ).toThrow(/refusing write outside mock\//);
    expect(() =>
      validateAndResolveVibePath(root, "specs/story-N.yaml")
    ).toThrow(/refusing write outside mock\//);
    expect(() =>
      validateAndResolveVibePath(root, "tests/integration/foo.test.ts")
    ).toThrow(/refusing write outside mock\//);
  });

  it("rejects absolute paths", () => {
    expect(() =>
      validateAndResolveVibePath(root, "/etc/passwd")
    ).toThrow(/refusing absolute path/);
  });

  it("rejects parent-dir escapes", () => {
    expect(() =>
      validateAndResolveVibePath(root, "../../etc/passwd")
    ).toThrow(/refusing parent-dir escape/);
  });

  it("rejects paths that normalize to escape", () => {
    expect(() =>
      validateAndResolveVibePath(root, "mock/../../escape")
    ).toThrow(/parent-dir|escaped|outside mock/);
  });
});

describe("writeVibeFiles", () => {
  it("writes each file at its specified mock/ path under repoRoot, creating dirs", () => {
    const repo = mkRepo();
    try {
      const written = writeVibeFiles(repo, [
        {
          path: "mock/scenarios/story-017.ts",
          contents: "export default { id: '017' };\n",
        },
        {
          path: "mock/src/lib/scenario-registry.ts",
          contents: "export const registry = [];\n",
        },
      ]);
      expect(written.sort()).toEqual([
        "mock/scenarios/story-017.ts",
        "mock/src/lib/scenario-registry.ts",
      ]);
      expect(existsSync(join(repo, "mock/scenarios/story-017.ts"))).toBe(true);
      expect(
        readFileSync(join(repo, "mock/src/lib/scenario-registry.ts"), "utf8")
      ).toContain("export const registry");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects unsafe paths before any write", () => {
    const repo = mkRepo();
    try {
      expect(() =>
        writeVibeFiles(repo, [
          { path: "mock/safe.ts", contents: "" },
          { path: "../escape.ts", contents: "" },
        ])
      ).toThrow(/refusing parent-dir escape/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("0.16.0-α.4: rejects any non-mock/ path before any write", () => {
    const repo = mkRepo();
    try {
      expect(() =>
        writeVibeFiles(repo, [
          { path: "mock/safe.ts", contents: "" },
          { path: "src/components/leaked.tsx", contents: "" },
        ])
      ).toThrow(/refusing write outside mock\//);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
