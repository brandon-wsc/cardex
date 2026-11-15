import { describe, expect, it } from "vitest";
import { Dec } from "./decimal";

// ADR 0011: the only place raw numbers touch arithmetic. Dec keeps money
// exact as a BigInt rational and rounds once, half-up, at the boundary.
describe("Dec — exact decimal arithmetic", () => {
  it("recovers the decimal a number names, including exponent form", () => {
    expect(Dec.of(0.1).toNumber()).toBe(0.1);
    expect(Dec.of(125.5).toNumber()).toBe(125.5);
    expect(Dec.of(1e-7).toNumber()).toBe(0.0000001);
    expect(Dec.of(-2.5).toNumber()).toBe(-2.5);
    expect(Dec.of(800).toNumber()).toBe(800);
  });

  it("rejects non-finite input", () => {
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      expect(() => Dec.of(bad)).toThrow(RangeError);
    }
  });

  it("keeps repeating fractions exact", () => {
    const third = Dec.of(1).div(3);
    expect(third.mul(3).cmp(Dec.of(1))).toBe(0);
  });

  it("rounds half-up at the requested precision", () => {
    expect(Dec.of(1.255).round(2).toNumber()).toBe(1.26);
    expect(Dec.of(0.775).round(2).toNumber()).toBe(0.78);
    expect(Dec.of(1.004999).round(2).toNumber()).toBe(1);
    expect(Dec.of(-1.255).round(2).toNumber()).toBe(-1.26);
  });

  it("compares decimal sums exactly", () => {
    expect(Dec.of(0.1).add(Dec.of(0.7)).cmp(Dec.of(0.8))).toBe(0);
    expect(Dec.of(300).sub(Dec.of(298.995)).cmp(Dec.of(1.005))).toBe(0);
  });
});
