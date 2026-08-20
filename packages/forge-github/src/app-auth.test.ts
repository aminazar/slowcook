import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appAuthConfigured, privateKeyFrom, mintInstallationToken } from "./app-auth.js";

describe("appAuthConfigured", () => {
  it("needs both an app id and a key source", () => {
    expect(appAuthConfigured({})).toBe(false);
    expect(appAuthConfigured({ SLOWCOOK_GITHUB_APP_ID: "7" })).toBe(false);
    expect(
      appAuthConfigured({ SLOWCOOK_GITHUB_APP_PRIVATE_KEY_PATH: "/x.pem" })
    ).toBe(false);
    expect(
      appAuthConfigured({
        SLOWCOOK_GITHUB_APP_ID: "7",
        SLOWCOOK_GITHUB_APP_PRIVATE_KEY_PATH: "/x.pem",
      })
    ).toBe(true);
    expect(
      appAuthConfigured({
        SLOWCOOK_GITHUB_APP_ID: "7",
        SLOWCOOK_GITHUB_APP_PRIVATE_KEY: "-----BEGIN...",
      })
    ).toBe(true);
  });
});

describe("privateKeyFrom", () => {
  it("rejects a key file that is not a PEM — a truncated or wrong file must be NAMED", () => {
    const dir = mkdtempSync(join(tmpdir(), "appauth-"));
    const p = join(dir, "not-a-key.pem");
    writeFileSync(p, "definitely not a key");
    expect(() =>
      privateKeyFrom({ SLOWCOOK_GITHUB_APP_PRIVATE_KEY_PATH: p })
    ).toThrow(/PEM/);
  });

  it("path wins over inline, and inline restores literal \\n", () => {
    const dir = mkdtempSync(join(tmpdir(), "appauth-"));
    const p = join(dir, "key.pem");
    writeFileSync(p, "-----BEGIN PRIVATE KEY-----\nfromfile\n-----END PRIVATE KEY-----\n");
    expect(
      privateKeyFrom({
        SLOWCOOK_GITHUB_APP_PRIVATE_KEY_PATH: p,
        SLOWCOOK_GITHUB_APP_PRIVATE_KEY: "inline",
      })
    ).toContain("fromfile");
    expect(
      privateKeyFrom({
        SLOWCOOK_GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
      })
    ).toContain("\nabc\n");
  });
});

describe("mintInstallationToken", () => {
  it("refuses loudly when unconfigured (never a silent operator fallback)", async () => {
    await expect(mintInstallationToken("o", "r", {})).rejects.toThrow(
      /SLOWCOOK_GITHUB_APP_ID/
    );
  });
});
