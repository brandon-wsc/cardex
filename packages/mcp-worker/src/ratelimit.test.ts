import { describe, expect, it } from "vitest";
import { overLimit, rateLimited } from "./ratelimit";

// Specs for the best-effort per-IP limiter: fixed windows, failure-counted
// limits only move on failure, and buckets age out.
describe("rateLimited / overLimit", () => {
  it("allows up to the limit then reports over", () => {
    const t = 1_000;
    for (let i = 0; i < 3; i++) {
      expect(rateLimited("k1", 3, 60_000, t + i)).toBe(false);
    }
    expect(rateLimited("k1", 3, 60_000, t + 3)).toBe(true);
    expect(rateLimited("k1", 3, 60_000, t + 4)).toBe(true);
  });

  it("starts a fresh window once the old one expires", () => {
    const t = 1_000;
    rateLimited("k2", 1, 1_000, t);
    expect(rateLimited("k2", 1, 1_000, t + 500)).toBe(true);
    expect(rateLimited("k2", 1, 1_000, t + 1_001)).toBe(false);
  });

  it("overLimit is read-only — a peek never consumes the budget", () => {
    const t = 1_000;
    rateLimited("k3", 2, 60_000, t);
    expect(overLimit("k3", 2, t)).toBe(false);
    expect(overLimit("k3", 2, t)).toBe(false);
    rateLimited("k3", 2, 60_000, t);
    expect(overLimit("k3", 2, t)).toBe(true);
    expect(overLimit("k3", 2, t + 60_001)).toBe(false);
  });

  it("keeps keys independent", () => {
    const t = 1_000;
    rateLimited("k4", 1, 60_000, t);
    expect(rateLimited("k4", 1, 60_000, t)).toBe(true);
    expect(rateLimited("k5", 1, 60_000, t)).toBe(false);
  });
});
