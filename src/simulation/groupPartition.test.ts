import { describe, expect, it } from "vitest";
import { partitionIntoGroups, planGroupSizes } from "./groupPartition";

describe("planGroupSizes", () => {
  it("returns no groups and no unassigned for an empty population", () => {
    expect(planGroupSizes(0, { minGroupSize: 3, maxGroupSize: 4 })).toEqual({
      groupSizes: [],
      unassignedCount: 0,
    });
  });

  it("does not silently shrink a fixed group size to absorb a remainder", () => {
    // 固定4人班で10人 -> 4+4のみ。3・3・4等へ暗黙に変更してはならない(受入条件)
    const plan = planGroupSizes(10, { minGroupSize: 4, maxGroupSize: 4 });
    expect(plan.groupSizes).toEqual([4, 4]);
    expect(plan.unassignedCount).toBe(2);
  });

  it("fully assigns a population that fits exactly into a fixed group size", () => {
    const plan = planGroupSizes(12, { minGroupSize: 4, maxGroupSize: 4 });
    expect(plan.groupSizes).toEqual([4, 4, 4]);
    expect(plan.unassignedCount).toBe(0);
  });

  it("assigns everyone for a variable-capacity population that can be fully partitioned", () => {
    // 10人を3〜4人班へ -> 4+3+3(全員割当、受入条件)
    const plan = planGroupSizes(10, { minGroupSize: 3, maxGroupSize: 4 });
    expect(plan.groupSizes.reduce((a, b) => a + b, 0)).toBe(10);
    expect(plan.unassignedCount).toBe(0);
    for (const size of plan.groupSizes) {
      expect(size).toBeGreaterThanOrEqual(3);
      expect(size).toBeLessThanOrEqual(4);
    }
  });

  it("leaves a minimal structural remainder for a variable-capacity population that cannot be fully partitioned", () => {
    // 5人を3〜4人班へ -> 4人班1つ(3人班+2人余りより割当人数が多いため優先される)、残り1人は班を作れない
    const plan = planGroupSizes(5, { minGroupSize: 3, maxGroupSize: 4 });
    expect(plan.groupSizes).toEqual([4]);
    expect(plan.unassignedCount).toBe(1);
  });

  it("returns no groups when the population is below the minimum", () => {
    const plan = planGroupSizes(2, { minGroupSize: 3, maxGroupSize: 4 });
    expect(plan.groupSizes).toEqual([]);
    expect(plan.unassignedCount).toBe(2);
  });

  it("leaves a lone person unassigned for a fixed group size (population = 1)", () => {
    const plan = planGroupSizes(1, { minGroupSize: 4, maxGroupSize: 4 });
    expect(plan.groupSizes).toEqual([]);
    expect(plan.unassignedCount).toBe(1);
  });

  it("leaves a lone person unassigned for a variable group size (population = 1)", () => {
    const plan = planGroupSizes(1, { minGroupSize: 3, maxGroupSize: 4 });
    expect(plan.groupSizes).toEqual([]);
    expect(plan.unassignedCount).toBe(1);
  });

  it("fully partitions a large fixed-size population (>= 100) with no implicit resizing", () => {
    const plan = planGroupSizes(101, { minGroupSize: 4, maxGroupSize: 4 });
    expect(plan.groupSizes.every((size) => size === 4)).toBe(true);
    expect(plan.groupSizes.length).toBe(25);
    expect(plan.unassignedCount).toBe(1); // 101 % 4 == 1
  });

  it("fully assigns a large variable-capacity population (>= 100) with no structural remainder", () => {
    const plan = planGroupSizes(101, { minGroupSize: 3, maxGroupSize: 4 });
    expect(plan.groupSizes.reduce((a, b) => a + b, 0)).toBe(101);
    expect(plan.unassignedCount).toBe(0);
    for (const size of plan.groupSizes) {
      expect(size).toBeGreaterThanOrEqual(3);
      expect(size).toBeLessThanOrEqual(4);
    }
  });

  it("treats an unbounded maxGroupSize as a single group when population meets the minimum", () => {
    const plan = planGroupSizes(7, { minGroupSize: 2, maxGroupSize: Number.POSITIVE_INFINITY });
    expect(plan.groupSizes).toEqual([7]);
    expect(plan.unassignedCount).toBe(0);
  });

  it("is deterministic across repeated calls with the same input", () => {
    const a = planGroupSizes(17, { minGroupSize: 3, maxGroupSize: 4 });
    const b = planGroupSizes(17, { minGroupSize: 3, maxGroupSize: 4 });
    expect(a).toEqual(b);
  });
});

describe("partitionIntoGroups", () => {
  it("fills groups from the front of the ordered list, leaving the tail unassigned", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `agent-${i}`);
    const { groups, unassignedIds } = partitionIntoGroups(ids, { minGroupSize: 4, maxGroupSize: 4 });

    expect(groups).toEqual([ids.slice(0, 4), ids.slice(4, 8)]);
    expect(unassignedIds).toEqual(ids.slice(8));
  });

  it("produces groups whose combined membership has no duplicates and covers only assigned ids", () => {
    const ids = Array.from({ length: 11 }, (_, i) => `agent-${i}`);
    const { groups, unassignedIds } = partitionIntoGroups(ids, { minGroupSize: 3, maxGroupSize: 4 });

    const allAssigned = groups.flat();
    expect(new Set(allAssigned).size).toBe(allAssigned.length);
    expect(allAssigned.length + unassignedIds.length).toBe(ids.length);
    for (const group of groups) {
      expect(group.length).toBeGreaterThanOrEqual(3);
      expect(group.length).toBeLessThanOrEqual(4);
    }
  });

  it("partitions a large population (>= 100) with no duplicates and full id coverage", () => {
    const ids = Array.from({ length: 103 }, (_, i) => `agent-${i}`);
    const { groups, unassignedIds } = partitionIntoGroups(ids, { minGroupSize: 3, maxGroupSize: 4 });

    const allAssigned = groups.flat();
    expect(new Set(allAssigned).size).toBe(allAssigned.length);
    expect(allAssigned.length + unassignedIds.length).toBe(ids.length);
    for (const group of groups) {
      expect(group.length).toBeGreaterThanOrEqual(3);
      expect(group.length).toBeLessThanOrEqual(4);
    }
  });
});
