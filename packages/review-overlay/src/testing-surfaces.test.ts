import { describe, it, expect } from "vitest";
import { resolveSelection, resolveSeed, selectionBreadcrumb, type Manifest } from "./testing-surfaces.js";

const M: Manifest = {
  epics: [
    {
      id: "payment", label: "Payment",
      profiles: { self: { id: "self", price: 60 } },
      contexts: [
        {
          id: "guest", label: "Guest (logged out)", group: "Logged out", base: "/p/", status: "anonymous",
          scenarios: [
            { id: "login", label: "Log in", route: "/login", states: [
              { id: "form", label: "Login form" },
              { id: "done", label: "Logged in", becomes: { context: "pf", route: "/patient/wallet" } },
            ] },
          ],
        },
        {
          id: "pf", label: "Patient · family", group: "Patients", base: "/p/", status: "authed",
          user: { id: "u1", firstName: "Mina" },
          scenarios: [
            { id: "cancel", label: "Cancel", route: "/patient/wallet", states: [
              { id: "has", label: "Has upcoming", seed: { balance: 42, profileIds: ["self"], upcoming: [{ id: "x", dateOffsetDays: 5 }] } },
            ] },
          ],
        },
        {
          id: "ti", label: "Therapist · Iran", group: "Therapists", base: "/t/", status: "authed",
          user: { id: "t1" },
          scenarios: [{ id: "payout", label: "Payout", route: "/therapist/accounting", states: [{ id: "w", label: "Withdrawable", seed: { fee: 20 } }] }],
        },
      ],
    },
  ],
};

describe("resolveSeed", () => {
  it("expands profileIds via the epic profiles table (with overrides)", () => {
    const out = resolveSeed({ profileIds: ["self"], profileOverrides: { self: { price: 99 } } }, { self: { id: "self", price: 60 } });
    expect(out.profiles).toEqual([{ id: "self", price: 99 }]);
    expect(out.profileIds).toBeUndefined();
  });
  it("resolves dateOffsetDays to a future ISO on upcoming/transactions", () => {
    const out = resolveSeed({ upcoming: [{ id: "x", dateOffsetDays: 5 }], transactions: [{ id: "t", dateOffsetDays: -2 }] }, {});
    const up = (out.upcoming as Array<Record<string, unknown>>)[0]!;
    const tx = (out.transactions as Array<Record<string, unknown>>)[0]!;
    expect(new Date(up.dateISO as string).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(tx.date as string).getTime()).toBeLessThan(Date.now());
  });
});

describe("resolveSelection", () => {
  it("authed context → status authed, user, resolved seed + url", () => {
    const r = resolveSelection(M, "payment", "pf", "cancel", "has")!;
    expect(r.selection.status).toBe("authed");
    expect(r.selection.user).toEqual({ id: "u1", firstName: "Mina" });
    expect(r.url).toBe("/p/patient/wallet");
    expect(r.selection.seed.profiles).toEqual([{ id: "self", price: 60 }]);
  });
  it("anonymous context → status anonymous, user null", () => {
    const r = resolveSelection(M, "payment", "guest", "login", "form")!;
    expect(r.selection.status).toBe("anonymous");
    expect(r.selection.user).toBeNull();
    expect(r.url).toBe("/p/login");
  });
  it("`becomes` flips to the target authed context + its route (login as outcome)", () => {
    const r = resolveSelection(M, "payment", "guest", "login", "done")!;
    expect(r.selection.contextId).toBe("pf");
    expect(r.selection.status).toBe("authed");
    expect(r.selection.user).toEqual({ id: "u1", firstName: "Mina" });
    expect(r.url).toBe("/p/patient/wallet");
  });
  it("cross-app therapist context resolves to /t/", () => {
    const r = resolveSelection(M, "payment", "ti", "payout", "w")!;
    expect(r.url).toBe("/t/therapist/accounting");
    expect(r.selection.seed).toEqual({ fee: 20 });
  });
  it("label uses the `›` hierarchy separator (context › scenario › state)", () => {
    const r = resolveSelection(M, "payment", "pf", "cancel", "has")!;
    expect(r.selection.label).toBe("Patient › Cancel › Has upcoming");
    expect(r.selection.label).not.toContain(" · ");
  });
  it("unknown ids → null", () => {
    expect(resolveSelection(M, "payment", "pf", "cancel", "nope")).toBeNull();
  });
});

describe("selectionBreadcrumb", () => {
  it("re-derives a `›` breadcrumb from the manifest by id", () => {
    const sel = resolveSelection(M, "payment", "pf", "cancel", "has")!.selection;
    expect(selectionBreadcrumb(M, sel)).toBe("Patient › Cancel › Has upcoming");
  });
  it("upgrades a legacy `·` stored label when the manifest lookup misses", () => {
    const legacy = { epicId: "x", contextId: "x", scenarioId: "x", stateId: "x", status: "authed" as const, route: "/", base: "/p/" as const, label: "Therapist · Bond · No-show penalty", user: null, seed: {}, fixtures: {} };
    expect(selectionBreadcrumb(M, legacy)).toBe("Therapist › Bond › No-show penalty");
    expect(selectionBreadcrumb(null, legacy)).toBe("Therapist › Bond › No-show penalty");
  });
});
