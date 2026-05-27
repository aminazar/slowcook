import { describe, it, expect } from "vitest";
import { parseEnumValues } from "./refresh-knowledge";

/**
 * Regression: `buildBackendEnumsDigest` used to inline the value-
 * extraction logic and the regex didn't strip JSDoc / line comments
 * before splitting on commas. Enums whose every value had a preceding
 * JSDoc block (a common consumer convention — observed in
 * delgoosh/monorepo's `packages/enums/src/appointments-status.enum.ts`)
 * yielded ZERO parsed values. The whole enum then dropped from
 * `backend-enums.md`, leaving testgen + refine without an
 * authoritative source for the value list.
 *
 * Symptom on the consumer side:
 *   $ grep -i AppointmentsStatus .brewing/repo-knowledge/auto/backend-enums.md
 *   (no output — but the enum exists at packages/enums/src/)
 *
 * Surfaced by a local-claude-pipeline session 2026-05-27 while
 * mimicking testgen for delgoosh story-009 (patient appointment list).
 */
describe("parseEnumValues — JSDoc + line-comment handling (regression)", () => {
  it("parses a JSDoc-decorated enum body without dropping any values", () => {
    const body = `
  /**
   * Appointment slot is available and free to be reserved
   */
  FREE = 'FREE',

  /**
   * Appointment is temporarily reserved before checkout is completed
   */
  RESERVED_BEFORE_CHECKOUT = 'RESERVED_BEFORE_CHECKOUT',

  /**
   * Appointment is confirmed and reserved
   */
  RESERVED = 'RESERVED',
`;
    expect(parseEnumValues(body)).toEqual([
      "FREE",
      "RESERVED_BEFORE_CHECKOUT",
      "RESERVED",
    ]);
  });

  it("parses a plain enum body (no comments) — existing behavior", () => {
    const body = `
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  ARCHIVED = 'ARCHIVED',
`;
    expect(parseEnumValues(body)).toEqual(["ACTIVE", "PAUSED", "ARCHIVED"]);
  });

  it("strips line comments too (// …) — defensive", () => {
    const body = `
  // legacy — kept for backwards-compat
  LEGACY = 'LEGACY',
  ACTIVE = 'ACTIVE',
`;
    expect(parseEnumValues(body)).toEqual(["LEGACY", "ACTIVE"]);
  });

  it("ignores values that aren't all-uppercase identifiers (e.g., string-init enums or numeric)", () => {
    const body = `
  Active = 'active',
  Paused = 'paused',
`;
    // Existing uppercase-only filter is preserved; this stays as
    // documentation of intent (slowcook digests target the
    // SCREAMING_SNAKE convention used in the consumer's enum files).
    expect(parseEnumValues(body)).toEqual([]);
  });
});
