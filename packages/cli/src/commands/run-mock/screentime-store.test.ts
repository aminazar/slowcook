// The shared screentime ledger (0.28.4) — one book per reviewer per REPO,
// origins irrelevant (Amin's ruling after seeing three disjoint localStorage
// banks across a monorepo's three review surfaces).
import { describe, it, expect } from "vitest";
import { deposit, report, loadBank, saveBank, makeIdentityResolver, type StoreIo } from "./screentime-store.js";
import { makeAuthHandler } from "./reviewer-auth-server.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const memIo = (): StoreIo & { text: string | null } => {
  const box = { text: null as string | null };
  return { get text() { return box.text; }, read: () => box.text, write: (t) => { box.text = t; } };
};

describe("screentime store", () => {
  it("deposits fold into login → repo → day, and the report reads one book", () => {
    const bank = {};
    deposit(bank, "aminazar", "monorepo", "2026-08-02", 240, 0);
    deposit(bank, "aminazar", "monorepo", "2026-08-03", 120, 1);
    deposit(bank, "aminazar", "monorepo", "2026-08-03", 960, 8); // another origin, SAME book
    deposit(bank, "someone-else", "monorepo", "2026-08-03", 999, 9); // not our book
    const r = report(bank, "aminazar", "monorepo", "2026-08-03");
    expect(r.todaySeconds).toBe(1080);   // 120 + 960 — the split books merge
    expect(r.weekSeconds).toBe(1320);
    expect(r.todayComments).toBe(9);
    expect(r.daysCounted).toBe(2);
    expect(r.days[0]).toEqual({ date: "2026-08-03", seconds: 1080, comments: 9 });
  });

  it("negative deposits are refused — a ledger only accumulates", () => {
    const bank = {};
    deposit(bank, "a", "p", "2026-08-03", -500, -2);
    expect(report(bank, "a", "p", "2026-08-03").todaySeconds).toBe(0);
  });

  it("identity resolver caches and maps a rejected token to null", async () => {
    let calls = 0;
    const resolver = makeIdentityResolver((async (url: string, init?: RequestInit) => {
      calls++;
      const tok = (init?.headers as Record<string, string>)["authorization"];
      return new Response(JSON.stringify(tok === "Bearer good" ? { login: "aminazar" } : { message: "bad" }), { status: tok === "Bearer good" ? 200 : 401 });
    }) as typeof fetch);
    expect(await resolver("good")).toBe("aminazar");
    expect(await resolver("good")).toBe("aminazar");
    expect(calls).toBe(1); // cached
    expect(await resolver("bad")).toBeNull();
  });

  it("round-trips through the injected io", () => {
    const io = memIo();
    const bank = loadBank(io);
    deposit(bank, "a", "p", "2026-08-03", 60, 1);
    saveBank(io, bank);
    expect(report(loadBank(io), "a", "p", "2026-08-03").todaySeconds).toBe(60);
  });
});

// drive the HTTP routes with fakes — no sockets
function drive(handler: (req: IncomingMessage, res: ServerResponse) => void, opts: { method: string; url: string; auth?: string; body?: unknown }): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve) => {
    const chunks = opts.body !== undefined ? [Buffer.from(JSON.stringify(opts.body))] : [];
    const req = Object.assign(
      (async function* () { yield* chunks; })(),
      { method: opts.method, url: opts.url, headers: { ...(opts.auth ? { authorization: `Bearer ${opts.auth}` } : {}) } },
    ) as unknown as IncomingMessage;
    let status = 0;
    const res = {
      setHeader() { /* cors */ },
      writeHead(code: number) { status = code; },
      end(text?: string) { resolve({ status, json: text ? JSON.parse(text) : null }); },
    } as unknown as ServerResponse;
    handler(req, res);
  });
}

describe("ledger routes on the auth helper", () => {
  const fakeAuth = { requestDeviceCode: async () => ({}), pollAccessToken: async () => ({}) } as never;
  const mk = (io: StoreIo) => makeAuthHandler(fakeAuth, "abcd", {
    io,
    resolveLogin: async (tok) => (tok === "good" ? "aminazar" : null),
    todayFn: () => "2026-08-03",
  });

  it("POST deposits under the token's own login; GET reads the same book", async () => {
    const io = memIo();
    const h = mk(io);
    const p1 = await drive(h, { method: "POST", url: "/screentime", auth: "good", body: { project: "monorepo", seconds: 120, comments: 1 } });
    expect(p1.status).toBe(200);
    const p2 = await drive(h, { method: "POST", url: "/screentime", auth: "good", body: { project: "monorepo", seconds: 60 } });
    expect(p2.status).toBe(200);
    const g = await drive(h, { method: "GET", url: "/screentime?project=monorepo", auth: "good" });
    expect(g.status).toBe(200);
    expect((g.json as { todaySeconds: number }).todaySeconds).toBe(180);
    expect((g.json as { todayComments: number }).todayComments).toBe(1);
  });

  it("no valid token, no ledger — 401 either direction", async () => {
    const h = mk(memIo());
    expect((await drive(h, { method: "GET", url: "/screentime?project=p", auth: "bad" })).status).toBe(401);
    expect((await drive(h, { method: "POST", url: "/screentime", auth: "bad", body: { project: "p", seconds: 9 } })).status).toBe(401);
  });

  it("a project is required — a deposit into nowhere is a config error", async () => {
    const h = mk(memIo());
    expect((await drive(h, { method: "POST", url: "/screentime", auth: "good", body: { seconds: 9 } })).status).toBe(400);
    expect((await drive(h, { method: "GET", url: "/screentime", auth: "good" })).status).toBe(400);
  });
});

describe("the chunk journal (0.28.5)", () => {
  it("each deposit journals its chunk — routes and pins — while totals stay summable scalars", () => {
    const bank = {};
    deposit(bank, "aminazar", "monorepo", "2026-08-03", 300, 0, { at: "2026-08-03T09:00:00Z", routes: ["/therapist/dashboard", "/therapist/calendar"] });
    deposit(bank, "aminazar", "monorepo", "2026-08-03", 0, 1, { at: "2026-08-03T09:02:00Z" });
    const day = (bank as Record<string, Record<string, Record<string, { s: number; c: number; chunks?: unknown[] }>>>)["aminazar"]!["monorepo"]!["2026-08-03"]!;
    expect(day.s).toBe(300);
    expect(day.c).toBe(1);
    expect(day.chunks).toHaveLength(2);
    expect(day.chunks![0]).toEqual({ at: "2026-08-03T09:00:00Z", s: 300, routes: ["/therapist/dashboard", "/therapist/calendar"] });
    expect(day.chunks![1]).toEqual({ at: "2026-08-03T09:02:00Z", s: 0, pins: 1 });
    // the report is a FOLD over scalars — the journal never has to be parsed
    expect(report(bank, "aminazar", "monorepo", "2026-08-03").todaySeconds).toBe(300);
  });

  it("an empty deposit journals nothing", () => {
    const bank = {};
    deposit(bank, "a", "p", "2026-08-03", 0, 0, { at: "t" });
    const day = (bank as Record<string, Record<string, Record<string, { chunks?: unknown[] }>>>)["a"]!["p"]!["2026-08-03"]!;
    expect(day.chunks).toBeUndefined();
  });
});

describe("lines moved (0.28.6) — dash's git-counted metric, ported", () => {
  it("pinGrep matches the citation habits without swallowing longer numbers", async () => {
    const { pinGrep } = await import("./screentime-store.js");
    const re = new RegExp(pinGrep(886));
    expect(re.test("fix per no.886 — calendar mobile")).toBe(true);
    expect(re.test("applies #886")).toBe(true);
    expect(re.test("(886) applied")).toBe(true);
    expect(re.test("fixes #8860")).toBe(false);
  });

  it("movedLines sums numstat added+deleted and ignores hashes/binary rows", async () => {
    const { movedLines } = await import("./screentime-store.js");
    expect(movedLines("abc123\n12\t3\tsrc/a.ts\n-\t-\tassets/logo.png\n0\t7\tsrc/b.ts\n")).toBe(22);
  });

  it("pinsAndLines folds search + git into per-day maps, degrading to empty on failure", async () => {
    const { pinsAndLines } = await import("./screentime-store.js");
    const fetchImpl = (async () => new Response(JSON.stringify({ items: [
      { number: 886, created_at: "2026-08-03T08:00:00Z" },
      { number: 880, created_at: "2026-08-02T10:00:00Z" },
    ] }), { status: 200 })) as unknown as typeof fetch;
    const runGit = async (args: string[]) => (args.some((a) => a.includes("886")) ? "h\n10\t5\tf.ts\n" : "h\n2\t1\tg.ts\n");
    const r = await pinsAndLines({ repoPath: "/x", repoFull: "delgoosh/monorepo", reviewLabel: "qa-review", runGit, fetchImpl }, "aminazar", "tok");
    expect(r.pinsPerDay.get("2026-08-03")).toBe(1);
    expect(r.linesPerDay.get("2026-08-03")).toBe(15);
    expect(r.linesPerDay.get("2026-08-02")).toBe(3);
  });

  it("the report carries lines only when derived, and GitHub's pin count outranks the deposit counter", async () => {
    const { deposit, report } = await import("./screentime-store.js");
    const bank = {};
    deposit(bank, "a", "p", "2026-08-03", 60, 2); // deposit says 2 pins
    const r = report(bank, "a", "p", "2026-08-03", { pinsPerDay: new Map([["2026-08-03", 5]]), linesPerDay: new Map([["2026-08-03", 40]]) });
    expect(r.todayComments).toBe(5);       // GitHub's own count wins
    expect(r.todayDiffLines).toBe(40);
    expect(r.weekDiffLines).toBe(40);
    const plain = report(bank, "a", "p", "2026-08-03");
    expect(plain.todayDiffLines).toBeUndefined(); // never invented
  });
});
