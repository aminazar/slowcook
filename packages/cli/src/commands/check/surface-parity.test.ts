// surface-parity (#261) — flag completeness + node-literal survival across
// build profiles, with the baseline ratchet. Builds are injected (opts.build)
// so the tests are pure-disk and fast.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runSurfaceParityCheck, scanFlagReads, scanNodeIds, loadBaseline, writeBaseline,
  type ParityConfig, type BaselineEntry,
} from "./surface-parity.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sc-parity-test-"));
  mkdirSync(join(root, "app/src/pages"), { recursive: true });
  writeFileSync(join(root, "app/src/pages/Wallet.tsx"), `
    const backend = import.meta.env.VITE_WALLET_BACKEND === "1";
    const gcid = import.meta.env["VITE_GOOGLE_CLIENT_ID"];
    export const W = () => <div {...rn("wallet/balance", "Balance")}>
      {backend && <div {...rn("wallet/agent-usage", "Agent usage")} />}
      <span data-review-node="wallet/ledger" />
    </div>;
  `);
  writeFileSync(join(root, "app/src/pages/Old.tsx"), `export const O = () => <div {...rn("old/retired", "Gone")} />;`);
  // id passed through a wrapper prop — the dash RateInput pattern
  writeFileSync(join(root, "app/src/pages/Forecast.tsx"), `
    export const F = () => <RateInput node="budget/assumption/labor-rate" reviewLabel="rate" />;
    const notANode = <Thing mode="fast" path="a/b/c" />; // path prop must NOT be picked up
  `);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const CONFIG: ParityConfig = {
  app: "app", src: "app/src", build: "unused {outDir}", env_prefix: "VITE_",
  markers: ["data-review-node"], baseline: ".slowcook/parity-baseline.yaml",
  profiles: {
    mock: { env: {}, allow_unset: [] },
    prod: { env: { VITE_WALLET_BACKEND: "1" }, require_all_flags: true, allow_unset: ["VITE_GOOGLE_CLIENT_ID"] },
  },
};

/** fake builder: writes a bundle whose content = the node ids each profile "kept". */
const builder = (kept: Record<string, string[]>) =>
  (profile: string, _env: Record<string, string>, outDir: string) =>
    writeFileSync(join(outDir, "index.js"), (kept[profile] ?? []).join("\n"));

describe("scanners", () => {
  it("harvests custom marker attributes (data-testid repos without rn())", () => {
    writeFileSync(join(root, "app/src/pages/Booking.tsx"), `
      export const B = () => <div data-testid="book-session-sheet"><span data-testid="fund-session-success" /></div>;
    `);
    const ids = scanNodeIds(root, "app/src", ["data-testid"]);
    expect(ids.has("book-session-sheet")).toBe(true);
    expect(ids.has("fund-session-success")).toBe(true);
    expect(ids.has("wallet/balance")).toBe(true); // rn() ids are always harvested
    expect(ids.has("wallet/ledger")).toBe(true); // slashed *node= props too (the fallback)
    rmSync(join(root, "app/src/pages/Booking.tsx"));
  });

  it("finds dot + bracket flag reads and rn()/data-review-node ids", () => {
    const flags = scanFlagReads(root, "app/src", "VITE_");
    expect([...flags.keys()].sort()).toEqual(["VITE_GOOGLE_CLIENT_ID", "VITE_WALLET_BACKEND"]);
    expect(flags.get("VITE_WALLET_BACKEND")).toMatch(/Wallet\.tsx:\d+/);
    const ids = scanNodeIds(root, "app/src");
    // includes the wrapper-prop id; excludes look-alike props (mode=, path=)
    expect([...ids].sort()).toEqual(["budget/assumption/labor-rate", "old/retired", "wallet/agent-usage", "wallet/balance", "wallet/ledger"]);
  });
});

describe("flag completeness", () => {
  it("an UNDECLARED flag in a require_all_flags profile fails; allow_unset and lax profiles don't", () => {
    const config: ParityConfig = { ...CONFIG, profiles: {
      mock: { env: {}, allow_unset: [] }, // lax: no require_all_flags
      prod: { env: {}, require_all_flags: true, allow_unset: ["VITE_GOOGLE_CLIENT_ID"] }, // missing WALLET_BACKEND
    } };
    const r = runSurfaceParityCheck(root, config, [], { build: builder({ mock: [], prod: [] }) });
    expect(r.flagViolations).toHaveLength(1);
    expect(r.flagViolations[0]).toMatchObject({ flag: "VITE_WALLET_BACKEND", profile: "prod" });
  });

  it("declaring the flag with an EMPTY value satisfies the check (deliberately off)", () => {
    const config: ParityConfig = { ...CONFIG, profiles: {
      mock: { env: {}, allow_unset: [] },
      prod: { env: { VITE_WALLET_BACKEND: "" }, require_all_flags: true, allow_unset: ["VITE_GOOGLE_CLIENT_ID"] },
    } };
    const r = runSurfaceParityCheck(root, config, [], { build: builder({ mock: [], prod: [] }) });
    expect(r.flagViolations).toHaveLength(0);
  });
});

describe("node parity + baseline ratchet", () => {
  const ALL = ["wallet/balance", "wallet/ledger", "wallet/agent-usage"];

  it("a node surviving in one profile but DCE'd from the other is NEW drift", () => {
    const r = runSurfaceParityCheck(root, CONFIG, [], {
      build: builder({ mock: ["wallet/balance", "wallet/ledger"], prod: ALL }),
    });
    expect(r.newDrift).toHaveLength(1);
    expect(r.newDrift[0]).toMatchObject({ node: "wallet/agent-usage", absent_from: ["mock"], presentIn: ["prod"] });
    expect([...r.deadNodes].sort()).toEqual(["budget/assumption/labor-rate", "old/retired"]);
  });

  it("a baselined divergence is waived, not failing", () => {
    const baseline: BaselineEntry[] = [{ node: "wallet/agent-usage", absent_from: ["mock"], reason: "live-only metering card" }];
    const r = runSurfaceParityCheck(root, CONFIG, baseline, {
      build: builder({ mock: ["wallet/balance", "wallet/ledger"], prod: ALL }),
    });
    expect(r.newDrift).toHaveLength(0);
    expect(r.waivedDrift.map((d) => d.node)).toEqual(["wallet/agent-usage"]);
  });

  it("drift that MOVED (different absent set than baselined) is new again — the conflict case", () => {
    const baseline: BaselineEntry[] = [{ node: "wallet/agent-usage", absent_from: ["mock"], reason: "was live-only" }];
    const r = runSurfaceParityCheck(root, CONFIG, baseline, {
      build: builder({ mock: ALL, prod: ["wallet/balance", "wallet/ledger"] }), // now absent from PROD instead
    });
    expect(r.newDrift.map((d) => d.node)).toEqual(["wallet/agent-usage"]);
  });

  it("a healed baseline entry is reported for pruning", () => {
    const baseline: BaselineEntry[] = [{ node: "wallet/ledger", absent_from: ["prod"], reason: "was missing" }];
    const r = runSurfaceParityCheck(root, CONFIG, baseline, {
      build: builder({ mock: ALL, prod: ALL }),
    });
    expect(r.newDrift).toHaveLength(0);
    expect(r.healed.map((h) => h.node)).toEqual(["wallet/ledger"]);
  });

  it("writeBaseline scaffolds reasons and PRESERVES prior ones; loadBaseline round-trips", () => {
    const prior: BaselineEntry[] = [{ node: "wallet/agent-usage", absent_from: ["mock"], reason: "live-only metering card", direction: "prod-first" }];
    writeBaseline(root, [
      { node: "wallet/agent-usage", absent_from: ["mock"], presentIn: ["prod"] },
      { node: "wallet/ledger", absent_from: ["prod"], presentIn: ["mock"] },
    ], prior);
    const loaded = loadBaseline(root);
    expect(loaded).toHaveLength(2);
    const usage = loaded.find((b) => b.node === "wallet/agent-usage")!;
    expect(usage.reason).toBe("live-only metering card");
    expect(usage.direction).toBe("prod-first");
    const ledger = loaded.find((b) => b.node === "wallet/ledger")!;
    expect(ledger.reason).toContain("TODO");
    expect(readFileSync(join(root, ".slowcook/parity-baseline.yaml"), "utf8")).toContain("ratchet");
  });
});
