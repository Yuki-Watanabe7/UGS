import { describe, expect, it } from "vitest";
import type { Agent, GroupCandidate } from "./types";
import { WORLD_WIDTH, WORLD_HEIGHT } from "./model";
import { DEFAULT_SPATIAL_DYNAMICS_CONFIG, validateSpatialDynamicsConfig, type SpatialDynamicsConfig } from "./spatialDynamics";
import {
  SPATIAL_OCCUPANCY_GRID_COLS,
  SPATIAL_OCCUPANCY_GRID_ROWS,
  computeCrowdingVector,
  computeSpatialOccupancyGridSnapshot,
} from "./spatialOccupancy";

/**
 * Issue #249 (Phase 6 P6-C後半、local crowding avoidance): docs/spatial-dynamics-phase6-model.md
 * §4(局所crowding field)+§8.1/§8.4(計測専用grid)の純粋関数群を検証する。engine.tsへの結線・
 * afterParty/classroomPairへの非干渉・disabled時のPhase 5互換はspatialOccupancyEngineWiring.test.tsで
 * カバーする。
 */

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-x",
    label: "X",
    x: 400,
    y: 260,
    vx: 0,
    vy: 0,
    willingness: 0.5,
    initiative: 0.3,
    ambiguityTolerance: 0.5,
    influenceAvoidance: 0.3,
    conformity: 0.5,
    leaveThreshold: 0.5,
    isObserverJoiner: false,
    state: "undecided",
    stress: 0,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<GroupCandidate>): GroupCandidate {
  return {
    id: "group-1",
    x: 400,
    y: 260,
    memberIds: [],
    status: "confirmed",
    age: 0,
    ...overrides,
  };
}

const CONFIG: SpatialDynamicsConfig = DEFAULT_SPATIAL_DYNAMICS_CONFIG;
const SELF = makeAgent({ id: "self", x: 400, y: 260, state: "undecided" });

describe("spatialDynamics config validation: crowding (Issue #249)", () => {
  it("既定configを受理する", () => {
    expect(() => validateSpatialDynamicsConfig(DEFAULT_SPATIAL_DYNAMICS_CONFIG)).not.toThrow();
  });

  it("crowdSampleRadius <= 0を拒否する", () => {
    expect(() => validateSpatialDynamicsConfig({ ...CONFIG, crowdSampleRadius: 0 })).toThrow();
  });

  it("crowdSampleDirectionsが非整数だと拒否する", () => {
    expect(() => validateSpatialDynamicsConfig({ ...CONFIG, crowdSampleDirections: 3.5 })).toThrow();
  });

  it("crowdSampleDirections < 1を拒否する", () => {
    expect(() => validateSpatialDynamicsConfig({ ...CONFIG, crowdSampleDirections: 0 })).toThrow();
  });

  it("crowdDensityThreshold < 0を拒否する", () => {
    expect(() => validateSpatialDynamicsConfig({ ...CONFIG, crowdDensityThreshold: -1 })).toThrow();
  });

  it("crowdRepulsionStrength < 0を拒否する", () => {
    expect(() => validateSpatialDynamicsConfig({ ...CONFIG, crowdRepulsionStrength: -1 })).toThrow();
  });

  it("crowdMaxContribution <= 0を拒否する", () => {
    expect(() => validateSpatialDynamicsConfig({ ...CONFIG, crowdMaxContribution: 0 })).toThrow();
  });

  it("crowdClusterCenterWeight < 0を拒否する", () => {
    expect(() => validateSpatialDynamicsConfig({ ...CONFIG, crowdClusterCenterWeight: -1 })).toThrow();
  });
});

describe("computeCrowdingVector (Issue #249 ADR §4)", () => {
  it("crowdingEnabled === false なら常に0", () => {
    const config = { ...CONFIG, crowdingEnabled: false };
    const other = makeAgent({ id: "other", x: SELF.x + 10, y: SELF.y });
    const result = computeCrowdingVector(SELF, [SELF, other], [], config);
    expect(result).toEqual({ vectorX: 0, vectorY: 0, magnitude: 0, localDensity: 0, crowded: false });
  });

  it("孤立agent(近傍もclusterもなし)ではvectorが0", () => {
    const result = computeCrowdingVector(SELF, [SELF], [], CONFIG);
    expect(result.vectorX).toBe(0);
    expect(result.vectorY).toBe(0);
    expect(result.magnitude).toBe(0);
    expect(result.localDensity).toBe(0);
    expect(result.crowded).toBe(false);
  });

  it("自分自身だけではrepulsionしない(agents配列に自分しかいない)", () => {
    const result = computeCrowdingVector(SELF, [SELF], [], CONFIG);
    expect(result.magnitude).toBe(0);
  });

  it("自分自身と完全に同じ座標の他agentがいてもNaN/Infinityにならない", () => {
    const overlap = makeAgent({ id: "overlap", x: SELF.x, y: SELF.y, state: "undecided" });
    const result = computeCrowdingVector(SELF, [SELF, overlap], [], CONFIG);
    expect(Number.isFinite(result.vectorX)).toBe(true);
    expect(Number.isFinite(result.vectorY)).toBe(true);
    expect(Number.isFinite(result.magnitude)).toBe(true);
  });

  it("一方向(+x側)に密集があると反対方向(-x)へ補正される", () => {
    const config = { ...CONFIG, crowdDensityThreshold: 0 };
    const neighbors = [
      makeAgent({ id: "n1", x: SELF.x + 20, y: SELF.y, state: "undecided" }),
      makeAgent({ id: "n2", x: SELF.x + 25, y: SELF.y + 5, state: "undecided" }),
      makeAgent({ id: "n3", x: SELF.x + 15, y: SELF.y - 5, state: "undecided" }),
    ];
    const result = computeCrowdingVector(SELF, [SELF, ...neighbors], [], config);
    expect(result.vectorX).toBeLessThan(0);
    expect(result.localDensity).toBeGreaterThan(0);
    expect(result.crowded).toBe(true);
  });

  it("左右対称な密集ではx方向のforceが相殺される", () => {
    const config = { ...CONFIG, crowdDensityThreshold: 0 };
    const neighbors = [
      makeAgent({ id: "left", x: SELF.x - 30, y: SELF.y, state: "undecided" }),
      makeAgent({ id: "right", x: SELF.x + 30, y: SELF.y, state: "undecided" }),
    ];
    const result = computeCrowdingVector(SELF, [SELF, ...neighbors], [], config);
    expect(result.vectorX).toBeCloseTo(0, 9);
  });

  it("密度が全方向で同じなら決定的に0になる(閾値と無関係)", () => {
    const config = { ...CONFIG, crowdDensityThreshold: 0, crowdSampleDirections: 4 };
    const neighbors = [
      makeAgent({ id: "n0", x: SELF.x + 20, y: SELF.y, state: "undecided" }),
      makeAgent({ id: "n1", x: SELF.x, y: SELF.y + 20, state: "undecided" }),
      makeAgent({ id: "n2", x: SELF.x - 20, y: SELF.y, state: "undecided" }),
      makeAgent({ id: "n3", x: SELF.x, y: SELF.y - 20, state: "undecided" }),
    ];
    const result = computeCrowdingVector(SELF, [SELF, ...neighbors], [], config);
    expect(result.vectorX).toBeCloseTo(0, 9);
    expect(result.vectorY).toBeCloseTo(0, 9);
  });

  it("同一cluster memberだけでは会話輪が崩壊しない(自クラスタmember・自クラスタ中心を除外)", () => {
    const joinedSelf = makeAgent({ id: "self", x: 400, y: 260, state: "joined", joinedGroupId: "own" });
    const ownCluster = makeCandidate({ id: "own", x: 405, y: 260, status: "confirmed" });
    const sameClusterMembers = [
      makeAgent({ id: "m1", x: 410, y: 260, state: "joined", joinedGroupId: "own" }),
      makeAgent({ id: "m2", x: 395, y: 255, state: "joined", joinedGroupId: "own" }),
    ];
    const result = computeCrowdingVector(joinedSelf, [joinedSelf, ...sameClusterMembers], [ownCluster], CONFIG);
    expect(result.localDensity).toBe(0);
    expect(result.magnitude).toBe(0);
    expect(result.crowded).toBe(false);
  });

  it("他clusterのmember・中心は密度source として数える(自クラスタとは扱いが異なる)", () => {
    const joinedSelf = makeAgent({ id: "self", x: 400, y: 260, state: "joined", joinedGroupId: "own" });
    const ownCluster = makeCandidate({ id: "own", x: 405, y: 260, status: "confirmed" });
    const otherCluster = makeCandidate({ id: "other", x: 430, y: 260, status: "confirmed" });
    const otherMember = makeAgent({ id: "om1", x: 425, y: 262, state: "joined", joinedGroupId: "other" });
    const config = { ...CONFIG, crowdDensityThreshold: 0 };
    const result = computeCrowdingVector(joinedSelf, [joinedSelf, otherMember], [ownCluster, otherCluster], config);
    expect(result.localDensity).toBeGreaterThan(0);
    expect(result.vectorX).toBeLessThan(0); // otherは+x側なので-x方向へ押される
  });

  it("leaving/leftのagentは密度に数えない", () => {
    const leavingNeighbor = makeAgent({ id: "leaving-1", x: SELF.x + 5, y: SELF.y, state: "leaving" });
    const leftNeighbor = makeAgent({ id: "left-1", x: SELF.x - 5, y: SELF.y, state: "left" });
    const result = computeCrowdingVector(SELF, [SELF, leavingNeighbor, leftNeighbor], [], CONFIG);
    expect(result.localDensity).toBe(0);
  });

  it("localDensityがcrowdDensityThreshold以下なら寄与0", () => {
    // crowdSampleRadius(70)の外周付近に1人だけ置き、密度をわずかにする
    const config = { ...CONFIG, crowdDensityThreshold: 100 };
    const neighbor = makeAgent({ id: "n1", x: SELF.x + 60, y: SELF.y, state: "undecided" });
    const result = computeCrowdingVector(SELF, [SELF, neighbor], [], config);
    expect(result.vectorX).toBeCloseTo(0, 9);
    expect(result.vectorY).toBeCloseTo(0, 9);
    expect(result.magnitude).toBeCloseTo(0, 9);
    expect(result.crowded).toBe(false);
    expect(result.localDensity).toBeGreaterThan(0); // 計測値自体はゼロではない
  });

  it("threshold境界付近で大きな不連続がない(距離を少しずつ変えても寄与が滑らかに変化する)", () => {
    const config = { ...CONFIG, crowdDensityThreshold: 0.5, crowdRepulsionStrength: 1, crowdMaxContribution: 100 };
    const magnitudes: number[] = [];
    for (let dist = 68; dist >= 20; dist -= 2) {
      const neighbor = makeAgent({ id: "n1", x: SELF.x + dist, y: SELF.y, state: "undecided" });
      const result = computeCrowdingVector(SELF, [SELF, neighbor], [], config);
      magnitudes.push(result.magnitude);
    }
    for (let i = 1; i < magnitudes.length; i++) {
      expect(Math.abs(magnitudes[i] - magnitudes[i - 1])).toBeLessThan(0.5);
    }
  });

  it("寄与はcrowdMaxContributionで頭打ちになる(密度が非常に高くても発散しない)", () => {
    const config = { ...CONFIG, crowdDensityThreshold: 0, crowdRepulsionStrength: 10, crowdMaxContribution: 2 };
    const neighbors = Array.from({ length: 20 }, (_, i) =>
      makeAgent({ id: `dense-${i}`, x: SELF.x + 5 + i, y: SELF.y, state: "undecided" }),
    );
    const result = computeCrowdingVector(SELF, [SELF, ...neighbors], [], config);
    expect(result.magnitude).toBeLessThanOrEqual(config.crowdMaxContribution + 1e-9);
  });

  it("cluster中心はcrowdClusterCenterWeightで重み付けされる(重みが大きいほど寄与が大きい)", () => {
    const other = makeCandidate({ id: "other", x: SELF.x + 20, y: SELF.y, status: "confirmed" });
    const lowWeight = { ...CONFIG, crowdDensityThreshold: 0, crowdClusterCenterWeight: 0.5, crowdMaxContribution: 100 };
    const highWeight = { ...CONFIG, crowdDensityThreshold: 0, crowdClusterCenterWeight: 3, crowdMaxContribution: 100 };
    const lowResult = computeCrowdingVector(SELF, [SELF], [other], lowWeight);
    const highResult = computeCrowdingVector(SELF, [SELF], [other], highWeight);
    expect(highResult.magnitude).toBeGreaterThan(lowResult.magnitude);
  });

  it("forming/dissolving/dissolved/expiredなclusterは密度source に含めない", () => {
    const notConfirmed: GroupCandidate[] = [
      makeCandidate({ id: "forming-1", x: SELF.x + 10, y: SELF.y, status: "forming" }),
      makeCandidate({ id: "dissolving-1", x: SELF.x + 10, y: SELF.y, status: "dissolving" }),
      makeCandidate({ id: "dissolved-1", x: SELF.x + 10, y: SELF.y, status: "dissolved" }),
      makeCandidate({ id: "expired-1", x: SELF.x + 10, y: SELF.y, status: "expired" }),
    ];
    const result = computeCrowdingVector(SELF, [SELF], notConfirmed, CONFIG);
    expect(result.localDensity).toBe(0);
  });

  it("input(agents配列)の順序を変えても結果が変わらない", () => {
    const config = { ...CONFIG, crowdDensityThreshold: 0 };
    const neighbors = [
      makeAgent({ id: "n1", x: SELF.x + 20, y: SELF.y, state: "undecided" }),
      makeAgent({ id: "n2", x: SELF.x - 15, y: SELF.y + 25, state: "joined", joinedGroupId: "other" }),
      makeAgent({ id: "n3", x: SELF.x + 5, y: SELF.y - 30, state: "approaching" }),
    ];
    const forward = computeCrowdingVector(SELF, [SELF, ...neighbors], [], config);
    const reversed = computeCrowdingVector(SELF, [SELF, ...[...neighbors].reverse()], [], config);
    expect(reversed.vectorX).toBeCloseTo(forward.vectorX, 9);
    expect(reversed.vectorY).toBeCloseTo(forward.vectorY, 9);
    expect(reversed.localDensity).toBeCloseTo(forward.localDensity, 9);
  });

  it("NaN/Infinityを発生させない(密な近傍・境界座標を含む)", () => {
    const near = makeAgent({ id: "corner-self", x: 2, y: 2, state: "undecided" });
    const neighbors = Array.from({ length: 10 }, (_, i) => makeAgent({ id: `c-${i}`, x: 2 + i, y: 2, state: "undecided" }));
    const result = computeCrowdingVector(near, [near, ...neighbors], [], CONFIG);
    expect(Number.isFinite(result.vectorX)).toBe(true);
    expect(Number.isFinite(result.vectorY)).toBe(true);
    expect(Number.isFinite(result.magnitude)).toBe(true);
    expect(Number.isFinite(result.localDensity)).toBe(true);
  });
});

describe("computeSpatialOccupancyGridSnapshot (Issue #249 実装範囲6節/ADR §8.1/§8.4)", () => {
  it("既定gridサイズは8x5", () => {
    expect(SPATIAL_OCCUPANCY_GRID_COLS).toBe(8);
    expect(SPATIAL_OCCUPANCY_GRID_ROWS).toBe(5);
  });

  it("agentがいない場合、occupied cellは0", () => {
    const snapshot = computeSpatialOccupancyGridSnapshot([]);
    expect(snapshot.occupiedCells).toEqual({ numerator: 0, denominator: 40, rate: 0 });
    expect(snapshot.cellOccupancy.count).toBe(40);
    expect(snapshot.cellOccupancy.max).toBe(0);
  });

  it("同じcellに複数agentがいても占有cell数は1", () => {
    const agents = [
      makeAgent({ id: "a1", x: 10, y: 10, state: "undecided" }),
      makeAgent({ id: "a2", x: 12, y: 12, state: "undecided" }),
    ];
    const snapshot = computeSpatialOccupancyGridSnapshot(agents);
    expect(snapshot.occupiedCells.numerator).toBe(1);
    expect(snapshot.cellOccupancy.max).toBe(2);
  });

  it("left/unassignedなagentは占有計測に含めない", () => {
    const agents = [
      makeAgent({ id: "a1", x: 10, y: 10, state: "left" }),
      makeAgent({ id: "a2", x: 10, y: 10, state: "unassigned" }),
    ];
    const snapshot = computeSpatialOccupancyGridSnapshot(agents);
    expect(snapshot.occupiedCells.numerator).toBe(0);
  });

  it("world境界そのもの(x === WORLD_WIDTH等)でも範囲外cellにならない", () => {
    const agents = [
      makeAgent({ id: "a1", x: WORLD_WIDTH, y: WORLD_HEIGHT, state: "undecided" }),
      makeAgent({ id: "a2", x: 0, y: 0, state: "undecided" }),
    ];
    expect(() => computeSpatialOccupancyGridSnapshot(agents)).not.toThrow();
    const snapshot = computeSpatialOccupancyGridSnapshot(agents);
    expect(snapshot.occupiedCells.numerator).toBe(2);
  });

  it("gridCols/gridRowsを指定できる(計測専用grid、crowding fieldとは独立)", () => {
    const agents = [makeAgent({ id: "a1", x: 400, y: 260, state: "undecided" })];
    const snapshot = computeSpatialOccupancyGridSnapshot(agents, 4, 2);
    expect(snapshot.gridCols).toBe(4);
    expect(snapshot.gridRows).toBe(2);
    expect(snapshot.occupiedCells.denominator).toBe(8);
  });

  it("複数cellに分散していれば占有比率が上がる", () => {
    const agents = [
      makeAgent({ id: "a1", x: 10, y: 10, state: "undecided" }),
      makeAgent({ id: "a2", x: WORLD_WIDTH - 10, y: WORLD_HEIGHT - 10, state: "undecided" }),
    ];
    const snapshot = computeSpatialOccupancyGridSnapshot(agents);
    expect(snapshot.occupiedCells.numerator).toBe(2);
    expect(snapshot.occupiedCells.rate).toBeCloseTo(2 / 40, 9);
  });
});
