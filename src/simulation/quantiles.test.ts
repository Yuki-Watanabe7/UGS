import { describe, expect, it } from "vitest";
import { computeQuantileSummary, quantile } from "./quantiles";

describe("quantile", () => {
  it("returns 0 for an empty array", () => {
    expect(quantile([], 50)).toBe(0);
    expect(quantile([], 90)).toBe(0);
  });

  it("returns the single value for a 1-element array regardless of p", () => {
    expect(quantile([42], 0)).toBe(42);
    expect(quantile([42], 50)).toBe(42);
    expect(quantile([42], 90)).toBe(42);
    expect(quantile([42], 100)).toBe(42);
  });

  it("interpolates for an even-length array", () => {
    // sorted: [1, 2, 3, 4] -> p50 rank = 1.5 -> interpolate between index1(2) and index2(3)
    expect(quantile([4, 1, 3, 2], 50)).toBe(2.5);
  });

  it("picks the exact element for an odd-length array", () => {
    // sorted: [1, 2, 3, 4, 5] -> p50 rank = 2 -> index2 = 3
    expect(quantile([5, 3, 1, 4, 2], 50)).toBe(3);
  });

  it("is not dragged below the true p90 by a single low outlier", () => {
    const values = [1, 10, 11, 12, 13, 14, 15, 16, 17, 18];
    const p90 = quantile(values, 90);
    // sorted: [1,10,...,18], rank = 0.9*9=8.1 -> between index8(17) and index9(18)
    expect(p90).toBeCloseTo(17.1, 5);
    expect(p90).toBeGreaterThan(quantile(values, 50));
  });

  it("clamps p to [0, 100]", () => {
    const values = [1, 2, 3];
    expect(quantile(values, -10)).toBe(quantile(values, 0));
    expect(quantile(values, 150)).toBe(quantile(values, 100));
  });

  it("does not mutate the input array", () => {
    const values = [3, 1, 2];
    quantile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("computeQuantileSummary", () => {
  it("returns p50/p90 both as 0 for an empty array", () => {
    expect(computeQuantileSummary([])).toEqual({ p50: 0, p90: 0 });
  });

  it("returns matching p50/p90 for a single value", () => {
    expect(computeQuantileSummary([7])).toEqual({ p50: 7, p90: 7 });
  });

  it("returns distinct p50/p90 for a spread of values", () => {
    const summary = computeQuantileSummary([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(summary.p50).toBeLessThan(summary.p90);
  });
});
