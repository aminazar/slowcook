import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parsePreviewConfig,
  readPreviewConfig,
  PreviewConfigError,
  urlForPort,
  containerNameForPr,
  imageTagForPr,
  remoteDirForPr,
} from "./config.js";

describe("parsePreviewConfig", () => {
  it("parses a minimal valid config under preview: wrapper", () => {
    const yaml = `preview:
  type: ssh
  host: preview.example.com
  user: slowcook-deploy
  key_secret: SLOWCOOK_PREVIEW_SSH_KEY
  port_range: [4000, 4099]
  url_template: "https://mock-{port}.preview.example.com"
  remote_root: /opt/slowcook-preview
`;
    const cfg = parsePreviewConfig(yaml);
    expect(cfg.type).toBe("ssh");
    expect(cfg.host).toBe("preview.example.com");
    expect(cfg.user).toBe("slowcook-deploy");
    expect(cfg.keySecret).toBe("SLOWCOOK_PREVIEW_SSH_KEY");
    expect(cfg.port).toBe(22);
    expect(cfg.portRange).toEqual([4000, 4099]);
    expect(cfg.urlTemplate).toBe("https://mock-{port}.preview.example.com");
    expect(cfg.remoteRoot).toBe("/opt/slowcook-preview");
    expect(cfg.mockDir).toBe("mock");
  });

  it("accepts a non-default ssh port and mock_dir", () => {
    const yaml = `preview:
  type: ssh
  host: box.internal
  user: deploy
  key_secret: SSH_KEY
  port: 2222
  url_template: "https://mock-{port}.boxes.test"
  remote_root: /srv/preview
  mock_dir: ui-mock
`;
    const cfg = parsePreviewConfig(yaml);
    expect(cfg.port).toBe(2222);
    expect(cfg.mockDir).toBe("ui-mock");
  });

  it("strips comments + blank lines", () => {
    const yaml = `# top comment
preview:
  # nested comment
  type: ssh

  host: a.b
  user: u
  key_secret: K
  url_template: "https://x-{port}.a.b"
  remote_root: /r
`;
    const cfg = parsePreviewConfig(yaml);
    expect(cfg.host).toBe("a.b");
    expect(cfg.urlTemplate).toBe("https://x-{port}.a.b");
  });

  it("strips both single and double quotes from string values", () => {
    const yaml = `preview:
  type: 'ssh'
  host: 'a.b.c'
  user: "deploy"
  key_secret: "K"
  url_template: 'https://m-{port}.x'
  remote_root: '/opt/x'
`;
    const cfg = parsePreviewConfig(yaml);
    expect(cfg.host).toBe("a.b.c");
    expect(cfg.user).toBe("deploy");
    expect(cfg.urlTemplate).toBe("https://m-{port}.x");
    expect(cfg.remoteRoot).toBe("/opt/x");
  });

  it("throws PreviewConfigError when type is not ssh", () => {
    const yaml = `preview:
  type: docker-registry
  host: x.x
  user: u
  key_secret: K
  url_template: "https://x-{port}"
  remote_root: /r
`;
    expect(() => parsePreviewConfig(yaml)).toThrow(PreviewConfigError);
    expect(() => parsePreviewConfig(yaml)).toThrow(/type must be "ssh"/);
  });

  it("throws when url_template is missing the {port} placeholder", () => {
    const yaml = `preview:
  type: ssh
  host: a
  user: u
  key_secret: K
  url_template: "https://no-placeholder.example.com"
  remote_root: /r
`;
    expect(() => parsePreviewConfig(yaml)).toThrow(/{port}/);
  });

  it("throws when port_range has invalid bounds", () => {
    const yaml = `preview:
  type: ssh
  host: a
  user: u
  key_secret: K
  port_range: [4099, 4000]
  url_template: "https://x-{port}.a"
  remote_root: /r
`;
    expect(() => parsePreviewConfig(yaml)).toThrow(/not a valid port range/);
  });

  it("throws when port_range syntax is malformed", () => {
    const yaml = `preview:
  type: ssh
  host: a
  user: u
  key_secret: K
  port_range: nope
  url_template: "https://x-{port}.a"
  remote_root: /r
`;
    expect(() => parsePreviewConfig(yaml)).toThrow(/expected "\[lo, hi\]"/);
  });

  it("lists each missing required field by name", () => {
    expect(() =>
      parsePreviewConfig(`preview:
  type: ssh
`)
    ).toThrow(/preview\.host is required/);
    expect(() =>
      parsePreviewConfig(`preview:
  type: ssh
  host: a.b
`)
    ).toThrow(/preview\.user is required/);
  });
});

describe("readPreviewConfig", () => {
  it("reads from .brewing/preview.yaml at the given repo root", () => {
    const repo = mkdtempSync(join(tmpdir(), "slowcook-preview-cfg-"));
    mkdirSync(join(repo, ".brewing"));
    writeFileSync(
      join(repo, ".brewing/preview.yaml"),
      `preview:
  type: ssh
  host: x.y
  user: u
  key_secret: K
  url_template: "https://m-{port}.x.y"
  remote_root: /opt/preview
`,
      "utf8"
    );
    const cfg = readPreviewConfig(repo);
    expect(cfg.host).toBe("x.y");
  });

  it("throws PreviewConfigError when .brewing/preview.yaml is missing", () => {
    const repo = mkdtempSync(join(tmpdir(), "slowcook-preview-cfg-empty-"));
    expect(() => readPreviewConfig(repo)).toThrow(PreviewConfigError);
    expect(() => readPreviewConfig(repo)).toThrow(/not found at/);
  });
});

describe("URL + naming helpers", () => {
  const cfg = {
    type: "ssh" as const,
    host: "h",
    user: "u",
    keySecret: "K",
    port: 22,
    portRange: [4000, 4099] as [number, number],
    urlTemplate: "https://mock-{port}.preview.test",
    remoteRoot: "/opt/preview",
    mockDir: "mock",
  };

  it("urlForPort substitutes {port}", () => {
    expect(urlForPort(cfg, 4015)).toBe("https://mock-4015.preview.test");
  });

  it("containerNameForPr is stable per PR", () => {
    expect(containerNameForPr(142)).toBe("slowcook-mock-pr-142");
  });

  it("imageTagForPr includes :latest", () => {
    expect(imageTagForPr(7)).toBe("slowcook-mock-pr-7:latest");
  });

  it("remoteDirForPr joins under remoteRoot", () => {
    expect(remoteDirForPr(cfg, 42)).toBe("/opt/preview/pr-42");
  });

  it("remoteDirForPr strips trailing slashes from remoteRoot", () => {
    expect(remoteDirForPr({ ...cfg, remoteRoot: "/opt/preview/" }, 42)).toBe("/opt/preview/pr-42");
  });
});
