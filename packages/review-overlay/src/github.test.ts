import { describe, it, expect, vi } from "vitest";
import {
  patStorageKey,
  loadPat,
  savePat,
  clearPat,
  submitComment,
  createIssue,
  type RepoCoord,
} from "./github.js";

const repo: RepoCoord = { owner: "aminazar", repo: "slowcook" };

function makeMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => { store.delete(k); },
    setItem: (k: string, v: string) => { store.set(k, v); },
  };
}

describe("PAT storage", () => {
  it("scopes the storage key by owner/repo", () => {
    expect(patStorageKey(repo)).toBe("slowcook.review-overlay.pat.aminazar/slowcook");
    expect(patStorageKey({ owner: "x", repo: "y" })).toBe("slowcook.review-overlay.pat.x/y");
  });

  it("loadPat returns null when nothing is stored", () => {
    const s = makeMemoryStorage();
    expect(loadPat(s, repo)).toBeNull();
  });

  it("savePat then loadPat round-trips the token", () => {
    const s = makeMemoryStorage();
    savePat(s, repo, "ghp_xxx");
    expect(loadPat(s, repo)).toBe("ghp_xxx");
  });

  it("clearPat removes the entry", () => {
    const s = makeMemoryStorage();
    savePat(s, repo, "ghp_xxx");
    clearPat(s, repo);
    expect(loadPat(s, repo)).toBeNull();
  });

  it("two repos can hold independent tokens in the same storage", () => {
    const s = makeMemoryStorage();
    savePat(s, { owner: "a", repo: "b" }, "ghp_a");
    savePat(s, { owner: "x", repo: "y" }, "ghp_x");
    expect(loadPat(s, { owner: "a", repo: "b" })).toBe("ghp_a");
    expect(loadPat(s, { owner: "x", repo: "y" })).toBe("ghp_x");
  });
});

describe("submitComment", () => {
  it("POSTs to the right URL with the right headers + body", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: 999, html_url: "https://github.com/o/r/issues/1#c-999" }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      )
    );
    const result = await submitComment({
      owner: "o",
      repo: "r",
      pr: 1,
      pat: "ghp_test",
      body: "hello",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.commentId).toBe(999);
      expect(result.htmlUrl).toBe("https://github.com/o/r/issues/1#c-999");
    }
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/o/r/issues/1/comments");
    const initObj = init as RequestInit;
    expect(initObj.method).toBe("POST");
    const headers = initObj.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer ghp_test");
    expect(headers["Accept"]).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(JSON.parse(initObj.body as string)).toEqual({ body: "hello" });
  });

  it("returns the GitHub error message on 401", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );
    const result = await submitComment({
      owner: "o",
      repo: "r",
      pr: 1,
      pat: "bad",
      body: "x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.message).toBe("Bad credentials");
    }
  });

  it("falls back to statusText when the GitHub error has no JSON body", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("oops", { status: 500, statusText: "Internal Server Error" })
    );
    const result = await submitComment({
      owner: "o",
      repo: "r",
      pr: 1,
      pat: "x",
      body: "x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.message).toBe("Internal Server Error");
    }
  });

  it("returns a network-error result when fetch throws", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ENETUNREACH"); });
    const result = await submitComment({
      owner: "o",
      repo: "r",
      pr: 1,
      pat: "x",
      body: "x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(0);
      expect(result.message).toContain("network error");
      expect(result.message).toContain("ENETUNREACH");
    }
  });

  it("respects an apiBase override", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ id: 1, html_url: "x" }), { status: 201 })
    );
    await submitComment({
      owner: "o",
      repo: "r",
      pr: 5,
      pat: "x",
      body: "x",
      apiBase: "https://github.example.com/api/v3",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      "https://github.example.com/api/v3/repos/o/r/issues/5/comments"
    );
  });
});

describe("createIssue", () => {
  it("POSTs to /issues with title+body+labels and returns the issue number", async () => {
    let captured: { url: string; body: unknown } | null = null;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return { ok: true, status: 201, json: async () => ({ number: 42, html_url: "http://gh/issues/42" }) } as Response;
    }) as unknown as typeof fetch;
    const res = await createIssue({
      owner: "aminazar", repo: "slowcook", pat: "tok",
      title: "[LCR] story-104 — x", body: "body", labels: ["lcr-review", "vibe"],
      fetchImpl,
    });
    expect(res).toEqual({ ok: true, commentId: 42, htmlUrl: "http://gh/issues/42" });
    expect(captured!.url).toBe("https://api.github.com/repos/aminazar/slowcook/issues");
    expect(captured!.body).toEqual({ title: "[LCR] story-104 — x", body: "body", labels: ["lcr-review", "vibe"] });
  });

  it("surfaces a GitHub error", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 403, json: async () => ({ message: "Forbidden" }) } as Response)) as typeof fetch;
    const res = await createIssue({ owner: "o", repo: "r", pat: "t", title: "x", body: "y", fetchImpl });
    expect(res).toEqual({ ok: false, status: 403, message: "Forbidden" });
  });
});
