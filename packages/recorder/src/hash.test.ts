import { describe, it, expect } from "vitest";
import { hashRequest } from "./hash.js";

describe("hashRequest", () => {
  it("returns 12-char hex", () => {
    const h = hashRequest({ method: "GET", url: "/api/foo" });
    expect(h).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is deterministic for the same input", () => {
    const a = hashRequest({ method: "POST", url: "/api/x", body: { a: 1 } });
    const b = hashRequest({ method: "POST", url: "/api/x", body: { a: 1 } });
    expect(a).toBe(b);
  });

  it("is order-insensitive for query-param order", () => {
    const a = hashRequest({ method: "GET", url: "/api/foo?a=1&b=2" });
    const b = hashRequest({ method: "GET", url: "/api/foo?b=2&a=1" });
    expect(a).toBe(b);
  });

  it("is order-insensitive for body-key order", () => {
    const a = hashRequest({ method: "POST", url: "/api/x", body: { a: 1, b: 2 } });
    const b = hashRequest({ method: "POST", url: "/api/x", body: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });

  it("differs when method differs", () => {
    const a = hashRequest({ method: "GET", url: "/api/foo" });
    const b = hashRequest({ method: "POST", url: "/api/foo" });
    expect(a).not.toBe(b);
  });

  it("differs when path differs", () => {
    const a = hashRequest({ method: "GET", url: "/api/foo" });
    const b = hashRequest({ method: "GET", url: "/api/bar" });
    expect(a).not.toBe(b);
  });

  it("differs when body value differs", () => {
    const a = hashRequest({ method: "POST", url: "/x", body: { a: 1 } });
    const b = hashRequest({ method: "POST", url: "/x", body: { a: 2 } });
    expect(a).not.toBe(b);
  });

  it("accepts JSON-string bodies equivalently to objects", () => {
    const a = hashRequest({ method: "POST", url: "/x", body: { a: 1 } });
    const b = hashRequest({ method: "POST", url: "/x", body: '{"a":1}' });
    expect(a).toBe(b);
  });
});
