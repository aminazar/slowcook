import { describe, it, expect } from "vitest";
import {
  buildManifest,
  manifestSubmitUrl,
  manifestFormHtml,
  parseConversionResponse,
} from "./app-manifest.js";

describe("buildManifest", () => {
  it("asks for exactly the agent permission set, webhook-free", () => {
    const m = buildManifest({ name: "slowcook-agent-x", port: 4207 });
    expect(m.default_permissions).toEqual({
      contents: "write",
      issues: "write",
      pull_requests: "write",
      metadata: "read",
    });
    expect(m.redirect_url).toBe("http://localhost:4207/callback");
    expect(m.public).toBe(false);
    expect(m).not.toHaveProperty("hook_attributes");
  });

  it("--public opts other accounts in", () => {
    expect(buildManifest({ name: "x", port: 1, makePublic: true }).public).toBe(true);
  });
});

describe("manifestSubmitUrl", () => {
  it("targets the org's app-creation page when an org is given", () => {
    expect(manifestSubmitUrl({ name: "x", port: 1, org: "reworthy" })).toBe(
      "https://github.com/organizations/reworthy/settings/apps/new"
    );
    expect(manifestSubmitUrl({ name: "x", port: 1 })).toBe(
      "https://github.com/settings/apps/new"
    );
  });
});

describe("manifestFormHtml", () => {
  it("embeds the manifest as an escaped hidden field that self-submits", () => {
    const html = manifestFormHtml({ name: "a&b", port: 4207 });
    expect(html).toContain('name="manifest"');
    expect(html).toContain("&quot;");
    expect(html).toContain("document.getElementById(\"f\").submit()");
  });
});

describe("parseConversionResponse", () => {
  it("extracts id/slug/pem and derives the install URL", () => {
    const app = parseConversionResponse({
      id: 42,
      slug: "slowcook-agent-reworthy",
      pem: "-----BEGIN PRIVATE KEY-----",
      html_url: "https://github.com/apps/slowcook-agent-reworthy",
    });
    expect(app.id).toBe(42);
    expect(app.installUrl).toBe(
      "https://github.com/apps/slowcook-agent-reworthy/installations/new"
    );
  });

  it("names the expired-code cause on a malformed response", () => {
    expect(() => parseConversionResponse({ message: "Not Found" })).toThrow(/expired/);
  });
});
