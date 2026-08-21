import { describe, it, expect } from "vitest";
import { rsyncArgs, remoteBuildScript, DEPLOY_EXCLUSIONS } from "./deploy.js";

describe("worker deploy (D7 / G1)", () => {
  it("rsync carries every G1 exclusion and trailing slashes", () => {
    const args = rsyncArgs("/src/slowcook", "rewo", "/root/slowcook-head");
    for (const e of DEPLOY_EXCLUSIONS) {
      expect(args.join(" ")).toContain(`--exclude ${e}`);
    }
    expect(args).toContain("/src/slowcook/");
    expect(args).toContain("rewo:/root/slowcook-head/");
    expect(args.join(" ")).toContain("--delete");
  });

  it("remote script forces the build and fails on any stale dist file", () => {
    const s = remoteBuildScript("/root/slowcook-head");
    expect(s).toContain("rm -rf packages/*/dist"); // orphaned artifacts are importable lies
    expect(s).toContain("*.tsbuildinfo"); // stale build state survives rsync exclusions — purge or tsc builds nothing
    expect(s).toContain("pnpm install");
    expect(s).toContain("pnpm -r --silent build"); // every package's OWN build — bare tsc left workspace deps to stale dist
    expect(s).toContain("chmod +x packages/cli/dist/cli.js"); // rebuilt cli.js loses the exec bit
    expect(s).toContain("! -newer .deploy-build-stamp");
    expect(s).toContain("exit 9");
    expect(s).toContain("DIST_FRESH");
  });
});
