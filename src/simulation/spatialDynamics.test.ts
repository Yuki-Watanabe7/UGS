import { describe, expect, it } from "vitest";
import type { Agent, GroupCandidate } from "./types";
import { WORLD_WIDTH, WORLD_HEIGHT } from "./model";
import {
  applyClusterSpatialDynamics,
  applyMemberFollow,
  advanceClusterVelocity,
  computeClusterRepulsionForce,
  computeWallAvoidanceForce,
  deterministicSeparationDirection,
  DEFAULT_SPATIAL_DYNAMICS_CONFIG,
  isClusterOverlapping,
  nearestClusterDistance,
  pruneSpatialRuntimeState,
  validateSpatialDynamicsConfig,
  type SpatialDynamicsConfig,
} from "./spatialDynamics";

/**
 * Issue #247 (Phase 6 P6-A/P6-B): docs/spatial-dynamics-phase6-model.md §2の純粋関数群を検証する。
 * engine.tsへの結線・非干渉(afterParty/classroomPair)・disabled時のPhase 5互換は
 * spatialDynamicsEngineWiring.test.tsでカバーする。
 */

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

const CONFIG: SpatialDynamicsConfig = DEFAULT_SPATIAL_DYNAMICS_CONFIG;

describe("spatialDynamics: config validation", () => {
  it("既定configを受理する", () => {
    expect(() => validateSpatialDynamicsConfig(DEFAULT_SPATIAL_DYNAMICS_CONFIG)).not.toThrow();
  });

  it("preferredClusterSeparation > repulsionRadiusを拒否する", () => {
    expect(() =>
      validateSpatialDynamicsConfig({ ...CONFIG, preferredClusterSeparation: 200, repulsionRadius: 120 }),
    ).toThrow();
  });

  it("maxMemberFollowStep > maxClusterCenterSpeedを拒否する", () => {
    expect(() =>
      validateSpatialDynamicsConfig({ ...CONFIG, maxMemberFollowStep: 5, maxClusterCenterSpeed: 2 }),
    ).toThrow();
  });

  it("damping = 1(境界値)を拒否する([0,1)の要件)", () => {
    expect(() => validateSpatialDynamicsConfig({ ...CONFIG, damping: 1 })).toThrow();
  });

  it("NaN/Infinityを拒否する", () => {
    expect(() => validateSpatialDynamicsConfig({ ...CONFIG, repulsionStrength: Number.NaN })).toThrow();
    expect(() => validateSpatialDynamicsConfig({ ...CONFIG, repulsionRadius: Number.POSITIVE_INFINITY })).toThrow();
  });
});

describe("spatialDynamics: deterministicSeparationDirection", () => {
  it("順序を入れ替えると厳密に逆向きになる(rng非消費・決定的)", () => {
    const forward = deterministicSeparationDirection("group-a", "group-b");
    const backward = deterministicSeparationDirection("group-b", "group-a");
    expect(forward.ux).toBeCloseTo(-backward.ux, 10);
    expect(forward.uy).toBeCloseTo(-backward.uy, 10);
    expect(Number.isFinite(forward.ux)).toBe(true);
    expect(Number.isFinite(forward.uy)).toBe(true);
  });

  it("同一入力なら常に同一方向を返す(決定的)", () => {
    const a = deterministicSeparationDirection("group-x", "group-y");
    const b = deterministicSeparationDirection("group-x", "group-y");
    expect(a).toEqual(b);
  });
});

describe("spatialDynamics: computeClusterRepulsionForce", () => {
  it("repulsionRadius以上離れていれば寄与は厳密に0", () => {
    const a = makeCandidate({ id: "a", x: 0, y: 0 });
    const b = makeCandidate({ id: "b", x: CONFIG.repulsionRadius + 1, y: 0 });
    const force = computeClusterRepulsionForce(a, b, CONFIG);
    expect(force).toEqual({ fx: 0, fy: 0 });
  });

  it("距離0でもNaN/Infinityを発生させず有限な方向へ分離する", () => {
    const a = makeCandidate({ id: "a", x: 300, y: 200 });
    const b = makeCandidate({ id: "b", x: 300, y: 200 });
    const force = computeClusterRepulsionForce(a, b, CONFIG);
    expect(Number.isFinite(force.fx)).toBe(true);
    expect(Number.isFinite(force.fy)).toBe(true);
    expect(force.fx === 0 && force.fy === 0).toBe(false);
  });

  it("preferredClusterSeparation未満では、それ以上の距離より強い斥力になる", () => {
    const a = makeCandidate({ id: "a", x: 0, y: 0 });
    const close = makeCandidate({ id: "b", x: CONFIG.preferredClusterSeparation - 10, y: 0 });
    const far = makeCandidate({ id: "c", x: CONFIG.preferredClusterSeparation + 10, y: 0 });
    const closeForce = computeClusterRepulsionForce(a, close, CONFIG);
    const farForce = computeClusterRepulsionForce(a, far, CONFIG);
    expect(Math.abs(closeForce.fx)).toBeGreaterThan(Math.abs(farForce.fx));
  });
});

describe("spatialDynamics: computeWallAvoidanceForce", () => {
  it("境界から十分離れていれば寄与0", () => {
    const c = makeCandidate({ x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 });
    const force = computeWallAvoidanceForce(c, CONFIG);
    expect(force).toEqual({ fx: 0, fy: 0 });
  });

  it("左壁近傍では内側(+x)へ押す", () => {
    const c = makeCandidate({ x: 5, y: WORLD_HEIGHT / 2 });
    const force = computeWallAvoidanceForce(c, CONFIG);
    expect(force.fx).toBeGreaterThan(0);
    expect(force.fy).toBe(0);
  });

  it("角(2辺同時近傍)では両軸が加算され、寄与がwallMaxContributionを超えない", () => {
    const c = makeCandidate({ x: 2, y: 2 });
    const force = computeWallAvoidanceForce(c, CONFIG);
    expect(force.fx).toBeGreaterThan(0);
    expect(force.fy).toBeGreaterThan(0);
    expect(Math.hypot(force.fx, force.fy)).toBeLessThanOrEqual(CONFIG.wallMaxContribution + 1e-9);
  });
});

describe("spatialDynamics: advanceClusterVelocity", () => {
  it("maxClusterCenterSpeedを超えない", () => {
    const velocity = advanceClusterVelocity(undefined, { fx: 1000, fy: 1000 }, CONFIG);
    expect(Math.hypot(velocity.vx, velocity.vy)).toBeLessThanOrEqual(CONFIG.maxClusterCenterSpeed + 1e-9);
  });

  it("力が0ならdampingにより前tickのvelocityが減衰する", () => {
    const velocity = advanceClusterVelocity({ vx: 1, vy: 0 }, { fx: 0, fy: 0 }, CONFIG);
    expect(velocity.vx).toBeCloseTo(CONFIG.damping, 10);
    expect(velocity.vy).toBeCloseTo(0, 10);
  });
});

describe("spatialDynamics: applyClusterSpatialDynamics (統合)", () => {
  it("近接する2 confirmed clusterは、斥力適用後に距離が広がる", () => {
    const a = makeCandidate({ id: "a", x: 380, y: 260 });
    const b = makeCandidate({ id: "b", x: 420, y: 260 });
    const before = Math.hypot(a.x - b.x, a.y - b.y);
    applyClusterSpatialDynamics([a, b], [], CONFIG, {});
    const after = Math.hypot(a.x - b.x, a.y - b.y);
    expect(after).toBeGreaterThan(before);
  });

  it("repulsionRadiusより十分離れた2 clusterは動かない", () => {
    const a = makeCandidate({ id: "a", x: 100, y: 260 });
    const b = makeCandidate({ id: "b", x: 700, y: 260 });
    const beforeA = { x: a.x, y: a.y };
    const beforeB = { x: b.x, y: b.y };
    applyClusterSpatialDynamics([a, b], [], CONFIG, {});
    expect(a.x).toBe(beforeA.x);
    expect(a.y).toBe(beforeA.y);
    expect(b.x).toBe(beforeB.x);
    expect(b.y).toBe(beforeB.y);
  });

  it("左右対称配置では重心が不自然にdriftしない", () => {
    const a = makeCandidate({ id: "a", x: 350, y: 260 });
    const b = makeCandidate({ id: "b", x: 450, y: 260 });
    const centroidBefore = (a.x + b.x) / 2;
    applyClusterSpatialDynamics([a, b], [], CONFIG, {});
    const centroidAfter = (a.x + b.x) / 2;
    expect(centroidAfter).toBeCloseTo(centroidBefore, 6);
  });

  it("完全同座標の2 clusterでもNaN/Infinityなく決定的に分離する", () => {
    const a = makeCandidate({ id: "a", x: 300, y: 200 });
    const b = makeCandidate({ id: "b", x: 300, y: 200 });
    applyClusterSpatialDynamics([a, b], [], CONFIG, {});
    expect(Number.isFinite(a.x)).toBe(true);
    expect(Number.isFinite(a.y)).toBe(true);
    expect(Number.isFinite(b.x)).toBe(true);
    expect(Number.isFinite(b.y)).toBe(true);
    expect(a.x === b.x && a.y === b.y).toBe(false);
  });

  it("3 cluster以上では、渡す配列の順序を変えても同じ結果になる", () => {
    const make = () => [
      makeCandidate({ id: "a", x: 300, y: 200 }),
      makeCandidate({ id: "b", x: 330, y: 210 }),
      makeCandidate({ id: "c", x: 310, y: 240 }),
    ];
    const forward = make();
    const reversed = [...make()].reverse();
    applyClusterSpatialDynamics(forward, [], CONFIG, {});
    applyClusterSpatialDynamics(reversed, [], CONFIG, {});
    const byId = (list: GroupCandidate[]) => new Map(list.map((c) => [c.id, { x: c.x, y: c.y }]));
    const forwardResult = byId(forward);
    const reversedResult = byId(reversed);
    for (const [id, pos] of forwardResult) {
      expect(reversedResult.get(id)!.x).toBeCloseTo(pos.x, 10);
      expect(reversedResult.get(id)!.y).toBeCloseTo(pos.y, 10);
    }
  });

  it("wall近傍のclusterはworld境界内へ戻る", () => {
    const c = makeCandidate({ id: "a", x: 21, y: 260 });
    applyClusterSpatialDynamics([c], [], CONFIG, {});
    expect(c.x).toBeGreaterThan(21);
    expect(c.x).toBeGreaterThanOrEqual(20);
    expect(c.x).toBeLessThanOrEqual(WORLD_WIDTH - 20);
  });

  it("極端な斥力強度でも1tickのcluster中心移動量はmaxClusterCenterSpeedを超えない", () => {
    const strongConfig: SpatialDynamicsConfig = { ...CONFIG, repulsionStrength: 10_000 };
    const a = makeCandidate({ id: "a", x: 395, y: 260 });
    const b = makeCandidate({ id: "b", x: 405, y: 260 });
    const before = { x: a.x, y: a.y };
    applyClusterSpatialDynamics([a, b], [], strongConfig, {});
    const moved = Math.hypot(a.x - before.x, a.y - before.y);
    expect(moved).toBeLessThanOrEqual(strongConfig.maxClusterCenterSpeed + 1e-9);
  });

  it("forming/dissolving/dissolved/expiredなclusterは力計算対象・移動対象から除外される", () => {
    const confirmed = makeCandidate({ id: "a", x: 395, y: 260, status: "confirmed" });
    const forming = makeCandidate({ id: "b", x: 400, y: 260, status: "forming" });
    const dissolving = makeCandidate({ id: "c", x: 396, y: 260, status: "dissolving" });
    const before = { forming: { x: forming.x, y: forming.y }, dissolving: { x: dissolving.x, y: dissolving.y } };
    applyClusterSpatialDynamics([confirmed, forming, dissolving], [], CONFIG, {});
    expect(forming.x).toBe(before.forming.x);
    expect(forming.y).toBe(before.forming.y);
    expect(dissolving.x).toBe(before.dissolving.x);
    expect(dissolving.y).toBe(before.dissolving.y);
  });

  it("joined memberはcluster中心の移動に、maxMemberFollowStepを上限に追従する(取り残されない)", () => {
    const strongConfig: SpatialDynamicsConfig = { ...CONFIG, repulsionStrength: 10 };
    const a = makeCandidate({ id: "a", x: 390, y: 260, memberIds: ["m1"] });
    const b = makeCandidate({ id: "b", x: 410, y: 260, memberIds: ["m2"] });
    const member = makeAgent({ id: "m1", state: "joined", joinedGroupId: "a", x: 390, y: 260 });
    applyClusterSpatialDynamics([a, b], [member], strongConfig, {});
    // memberはcluster中心と同じ相対位置(この場合オフセット0)を保ったまま、中心の移動へ追従する
    expect(member.x).toBeCloseTo(a.x, 6);
    expect(member.y).toBeCloseTo(a.y, 6);
  });

  it("memberの1tick移動量はmaxMemberFollowStepを超えない", () => {
    const a = makeCandidate({ id: "a", x: 400, y: 260, memberIds: ["m1"] });
    // 中心から遠く離れた位置に置き、中心の移動とは無関係に「desired位置への飛びつき」が
    // maxMemberFollowStepでclampされることを確認する
    const centersBefore = new Map([["a", { x: 400, y: 260 }]]);
    a.x = 410; // 中心がこのtickで10動いたことにする
    const member = makeAgent({ id: "m1", state: "joined", joinedGroupId: "a", x: 300, y: 260 });
    const before = { x: member.x, y: member.y };
    applyMemberFollow([member], [a], centersBefore, CONFIG);
    const moved = Math.hypot(member.x - before.x, member.y - before.y);
    expect(moved).toBeLessThanOrEqual(CONFIG.maxMemberFollowStep + 1e-9);
  });
});

describe("spatialDynamics: 診断selector", () => {
  it("nearestClusterDistance / isClusterOverlapping", () => {
    const a = makeCandidate({ id: "a", x: 0, y: 0 });
    const b = makeCandidate({ id: "b", x: 30, y: 0 });
    const c = makeCandidate({ id: "c", x: 500, y: 0 });
    expect(nearestClusterDistance(a, [a, b, c])).toBeCloseTo(30, 6);
    expect(isClusterOverlapping(a, [a, b, c], CONFIG)).toBe(true);
    expect(isClusterOverlapping(c, [a, b, c], CONFIG)).toBe(false);
  });

  it("他にactive clusterがなければnearestClusterDistanceはundefined", () => {
    const a = makeCandidate({ id: "a", x: 0, y: 0 });
    expect(nearestClusterDistance(a, [a])).toBeUndefined();
  });
});

describe("spatialDynamics: pruneSpatialRuntimeState", () => {
  it("配列から除去された/confirmedでなくなったclusterのvelocity entryを削除する", () => {
    const stillActive = makeCandidate({ id: "a", status: "confirmed" });
    const nowDissolving = makeCandidate({ id: "b", status: "dissolving" });
    const runtimeState = {
      clusterVelocity: {
        a: { vx: 1, vy: 1 },
        b: { vx: 1, vy: 1 },
        // "c"はもう`candidates`配列に存在しない(除去済み)孤児entry
        c: { vx: 1, vy: 1 },
      },
      roaming: {},
    };
    const pruned = pruneSpatialRuntimeState(runtimeState, [stillActive, nowDissolving]);
    expect(Object.keys(pruned.clusterVelocity)).toEqual(["a"]);
  });
});
