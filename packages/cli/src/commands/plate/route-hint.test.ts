import { describe, it, expect } from "vitest";
import { routeOf, routeHint } from "./route-hint.js";

describe("routeOf — LCR free-nav route derivation", () => {
  it("prefers the explicit pathname + route_query (LCR-mode payload)", () => {
    expect(
      routeOf({ pathname: "/r/webb-deep-field", route_query: "?clean=1", url: "http://x/ignored" }),
    ).toBe("/r/webb-deep-field?clean=1");
  });

  it("uses pathname alone when there is no query", () => {
    expect(routeOf({ pathname: "/discover", url: "http://x" })).toBe("/discover");
  });

  it("falls back to parsing url when pathname is absent (scenario / old payload)", () => {
    expect(routeOf({ url: "http://localhost:3100/u/lena?x=1" })).toBe("/u/lena");
  });

  it("returns undefined when neither pathname nor a parseable url exists", () => {
    expect(routeOf({ url: "not a url" })).toBeUndefined();
  });
});

describe("routeHint — agent timeline fragment", () => {
  it("formats a backticked route fragment", () => {
    expect(routeHint({ pathname: "/blocks", url: "http://x" })).toBe(" on route `/blocks`");
  });

  it("is empty when the route is unknowable", () => {
    expect(routeHint({ url: "::::" })).toBe("");
  });
});
