import { describe, it, expect } from "vitest";
import { scrub, detectUnscrubbed } from "./scrub.js";

describe("scrub", () => {
  it("replaces UUIDs", () => {
    const out = scrub({ id: "a8b3c9d0-1234-4567-89ab-1234567890ab" });
    expect(out).toEqual({ id: "<UUID>" });
  });

  it("replaces ISO timestamps", () => {
    const out = scrub({ created_at: "2026-04-23T12:00:00.000Z" });
    expect(out).toEqual({ created_at: "<TIMESTAMP>" });
  });

  it("replaces emails", () => {
    const out = scrub({ owner: "alice@example.com" });
    expect(out).toEqual({ owner: "<EMAIL>" });
  });

  it("replaces JWTs", () => {
    const out = scrub({
      token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJpYW0ifQ.XYZ1234567890_abc",
    });
    expect(out).toEqual({ token: "<JWT>" });
  });

  it("replaces Supabase keys", () => {
    const out = scrub({ k: "sbp_0123456789abcdef0123456789abcdef01234567" });
    expect(out).toEqual({ k: "<SUPABASE_KEY>" });
  });

  it("replaces Bearer tokens", () => {
    const out = scrub({
      auth: "Bearer abcdefghijklmnopqrstuvwxyz1234567890",
    });
    expect(out).toEqual({ auth: "Bearer <TOKEN>" });
  });

  it("walks nested structures", () => {
    const out = scrub({
      user: { id: "a8b3c9d0-1234-4567-89ab-1234567890ab", email: "x@y.zz" },
      tokens: ["eyJhbGciOiJIUzI1NiJ9.aaaaaaaaaaa.bbbbbbbbbb"],
    });
    expect(out).toEqual({
      user: { id: "<UUID>", email: "<EMAIL>" },
      tokens: ["<JWT>"],
    });
  });

  it("respects the allowList", () => {
    const out = scrub(
      { id: "00000000-0000-0000-0000-000000000001" },
      { allowList: ["00000000-0000-0000-0000-000000000001"] }
    );
    expect(out).toEqual({ id: "00000000-0000-0000-0000-000000000001" });
  });

  it("respects the skip list", () => {
    const out = scrub(
      { id: "a8b3c9d0-1234-4567-89ab-1234567890ab" },
      { skip: ["uuid"] }
    );
    expect(out).toEqual({ id: "a8b3c9d0-1234-4567-89ab-1234567890ab" });
  });

  it("leaves non-string scalars untouched", () => {
    const out = scrub({ count: 42, active: true, ratio: 0.5, nothing: null });
    expect(out).toEqual({ count: 42, active: true, ratio: 0.5, nothing: null });
  });
});

describe("detectUnscrubbed", () => {
  it("returns [] for clean fixtures", () => {
    expect(
      detectUnscrubbed({ id: "<UUID>", email: "<EMAIL>" })
    ).toEqual([]);
  });

  it("flags unscrubbed content", () => {
    const hits = detectUnscrubbed({
      id: "a8b3c9d0-1234-4567-89ab-1234567890ab",
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.pattern).toBe("uuid");
  });
});
