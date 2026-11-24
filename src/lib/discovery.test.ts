import { describe, expect, it } from "vitest";
import {
  curvePriceImpactBps,
  priceFromSqrt,
  sortLaunches,
  type LaunchRecord,
} from "./discovery";

describe("priceFromSqrt", () => {
  it("matches the live KPTEST spot price (Q64.64)", () => {
    // sqrtPrice read live from the KPTEST curve, 24 Nov 2026; the live
    // quote execution price was 0.0001241 WETH/KPTEST, i.e. 121 bps above
    // this spot. The old Q64.96 divisor gave 6.6e-24 here instead.
    const spot = priceFromSqrt(6459328666570192991801n, 9, 18);
    expect(spot).toBeCloseTo(0.0001226, 7);
    expect(spot).toBeGreaterThan(0.0001);
  });

  it("treats sqrtPrice as Q64.64", () => {
    expect(priceFromSqrt(1n << 64n, 18, 18)).toBe(1);
    expect(priceFromSqrt(1n << 64n, 9, 18)).toBe(1e-9);
    expect(priceFromSqrt(1n << 64n, 18, 9)).toBe(1e9);
  });
});

describe("curvePriceImpactBps", () => {
  const SPOT_ONE = 1n << 64n; // sqrtPrice for a spot price of 1

  it("returns null for non-positive inputs", () => {
    expect(curvePriceImpactBps(1000n, 990n, 0n, true)).toBeNull();
    expect(curvePriceImpactBps(0n, 990n, SPOT_ONE, true)).toBeNull();
    expect(curvePriceImpactBps(1000n, 0n, SPOT_ONE, true)).toBeNull();
  });

  it("returns zero when execution equals spot", () => {
    expect(curvePriceImpactBps(1000n, 1000n, SPOT_ONE, true)).toBe(0n);
  });

  it("measures a 1% move as 100 bps (base for quote)", () => {
    expect(curvePriceImpactBps(1000n, 990n, SPOT_ONE, true)).toBe(100n);
  });

  it("measures the reverse direction (quote for base)", () => {
    expect(curvePriceImpactBps(1000n, 990n, SPOT_ONE, false)).toBe(101n);
  });
});

describe("sortLaunches", () => {
  const record = (blockNumber: string): LaunchRecord =>
    ({ blockNumber }) as LaunchRecord;

  it("sorts newest block first without mutating the input", () => {
    const input = [record("3"), record("1"), record("2")];
    const sorted = sortLaunches(input);
    expect(sorted.map((l) => l.blockNumber)).toEqual(["3", "2", "1"]);
    expect(input.map((l) => l.blockNumber)).toEqual(["3", "1", "2"]);
  });
});
