import { describe, expect, it } from "vitest";
import type { Agent } from "./types";
import { WORLD_WIDTH, WORLD_HEIGHT } from "./model";
import { DEFAULT_SPATIAL_DYNAMICS_CONFIG, validateSpatialDynamicsConfig, type SpatialDynamicsConfig } from "./spatialDynamics";
import {
  advanceRoamingHeading,
  applyAgentRoamingStep,
  computeAgentWallAvoidanceForce,
  computeRoamingVector,
  createSpatialRandom,
  getRoamingState,
  movementDistance,
  roamingIntensity,
  roamingTicksRemaining,
  type RoamingState,
} from "./roaming";

/**
 * Issue #248 (Phase 6 P6-C相当のうちroaming + agent wall avoidance): docs/spatial-dynamics-phase6-model.md
 * §3(persistent roaming)+§1.4(agent movement合成・wall avoidance)の純粋関数群を検証する。
 * engine.tsへの結線・非干渉(afterParty/classroomPair)・disabled時のPhase 5互換は
 * roamingEngineWiring.test.tsでカバーする。
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

const CONFIG: SpatialDynamicsConfig = DEFAULT_SPATIAL_DYNAMICS_CONFIG;

describe("spatialDynamics config validation: roaming/agent wall avoidance (Issue #248)", () => {
  it("既定configを受理する", () => {
    expect(() => validateSpatialDynamicsConfig(DEFAULT_SPATIAL_DYNAMICS_CONFIG)).not.toThrow();
  });

  it("roamingHeadingHoldTicksMax < roamingHeadingHoldTicksMinを拒否する", () => {
    expect(() =>
      validateSpatialDynamicsConfig({ ...CONFIG, roamingHeadingHoldTicksMin: 20, roamingHeadingHoldTicksMax: 8 }),
    ).toThrow();
  });

  it("roamingHeadingHoldTicksMinが非整数だと拒否する", () => {
    expect(() => validateSpatialDynamicsConfig({ ...CONFIG, roamingHeadingHoldTicksMin: 1.5 })).toThrow();
  });

  it("roamingHeadingNoiseRadiansがπを超えると拒否する", () => {
    expect(() => validateSpatialDynamicsConfig({ ...CONFIG, roamingHeadingNoiseRadians: Math.PI + 0.1 })).toThrow();
  });

  it("roamingIntensityBaseが[0,1]の範囲外だと拒否する", () => {
    expect(() => validateSpatialDynamicsConfig({ ...CONFIG, roamingIntensityBase: 1.5 })).toThrow();
  });

  it("maxAgentSpeed <= 0を拒否する", () => {
    expect(() => validateSpatialDynamicsConfig({ ...CONFIG, maxAgentSpeed: 0 })).toThrow();
  });
});

describe("createSpatialRandom (Issue #248 ADR §9.3)", () => {
  it("同一runSeed/stage/agentId/tickなら同じ乱数系列になる", () => {
    const a = createSpatialRandom(7, "roaming", "agent-1", 12);
    const b = createSpatialRandom(7, "roaming", "agent-1", 12);
    expect(a.next()).toBe(b.next());
  });

  it("agentIdが違えば異なる系列になる", () => {
    const a = createSpatialRandom(7, "roaming", "agent-1", 12);
    const b = createSpatialRandom(7, "roaming", "agent-2", 12);
    expect(a.next()).not.toBe(b.next());
  });

  it("tickが違えば異なる系列になる", () => {
    const a = createSpatialRandom(7, "roaming", "agent-1", 12);
    const b = createSpatialRandom(7, "roaming", "agent-1", 13);
    expect(a.next()).not.toBe(b.next());
  });
});

describe("advanceRoamingHeading (Issue #248 ADR §3.2)", () => {
  it("初回はheading・hold期間を新規に生成する", () => {
    const state = advanceRoamingHeading(undefined, "agent-1", 0, 1, CONFIG);
    expect(Number.isFinite(state.headingRadians)).toBe(true);
    expect(state.headingRadians).toBeGreaterThanOrEqual(-Math.PI);
    expect(state.headingRadians).toBeLessThanOrEqual(Math.PI);
    expect(state.expiresAtTick).toBeGreaterThan(0);
  });

  it("expiresAtTickより前のtickではheadingが変わらない(毎tick独立random walkにならない)", () => {
    const first = advanceRoamingHeading(undefined, "agent-1", 0, 1, CONFIG);
    for (let tick = 1; tick < first.expiresAtTick; tick++) {
      const held = advanceRoamingHeading(first, "agent-1", tick, 1, CONFIG);
      expect(held).toBe(first); // 同一参照(再計算していない)
    }
  });

  it("expiresAtTick以降は前回headingからの摂動として更新される(全方位への再抽選ではない)", () => {
    const first = advanceRoamingHeading(undefined, "agent-1", 0, 1, CONFIG);
    const next = advanceRoamingHeading(first, "agent-1", first.expiresAtTick, 1, CONFIG);
    expect(next).not.toBe(first);
    const rawDiff = Math.abs(next.headingRadians - first.headingRadians);
    const wrappedDiff = Math.min(rawDiff, 2 * Math.PI - rawDiff);
    expect(wrappedDiff).toBeLessThanOrEqual(CONFIG.roamingHeadingNoiseRadians + 1e-9);
  });

  it("同一seed・同一入力なら常に同じ結果になる(seed再現性)", () => {
    const a1 = advanceRoamingHeading(undefined, "agent-1", 0, 42, CONFIG);
    const a2 = advanceRoamingHeading(undefined, "agent-1", 0, 42, CONFIG);
    expect(a1).toEqual(a2);
  });

  it("hold期間は[roamingHeadingHoldTicksMin, roamingHeadingHoldTicksMax]の範囲に収まる", () => {
    for (let seed = 0; seed < 30; seed++) {
      const state = advanceRoamingHeading(undefined, "agent-1", 0, seed, CONFIG);
      const holdTicks = state.expiresAtTick - 0;
      expect(holdTicks).toBeGreaterThanOrEqual(CONFIG.roamingHeadingHoldTicksMin);
      expect(holdTicks).toBeLessThanOrEqual(CONFIG.roamingHeadingHoldTicksMax);
    }
  });
});

describe("roamingIntensity (Issue #248 ADR §3.3)", () => {
  it("socialCirculationTendency未設定は0.5へフォールバックする", () => {
    const agent = makeAgent({ socialCirculationTendency: undefined });
    const expected = CONFIG.roamingIntensityBase + CONFIG.roamingCirculationWeight * 0.5;
    expect(roamingIntensity(agent, CONFIG)).toBeCloseTo(expected, 10);
  });

  it("circulationRoamingWeight = 0ならsocialCirculationTendencyに関係なく一様になる", () => {
    const config = { ...CONFIG, roamingCirculationWeight: 0 };
    const low = roamingIntensity(makeAgent({ socialCirculationTendency: 0 }), config);
    const high = roamingIntensity(makeAgent({ socialCirculationTendency: 1 }), config);
    expect(low).toBeCloseTo(high, 10);
    expect(low).toBeCloseTo(config.roamingIntensityBase, 10);
  });

  it("socialCirculationTendencyが高いほど強度が上がる(既存hazard式は変更しない、読み取り専用の再利用)", () => {
    const low = roamingIntensity(makeAgent({ socialCirculationTendency: 0 }), CONFIG);
    const high = roamingIntensity(makeAgent({ socialCirculationTendency: 1 }), CONFIG);
    expect(high).toBeGreaterThan(low);
  });

  it("結果は常に[0,1]にclampされる", () => {
    const config = { ...CONFIG, roamingIntensityBase: 0.9, roamingCirculationWeight: 0.9 };
    expect(roamingIntensity(makeAgent({ socialCirculationTendency: 1 }), config)).toBeLessThanOrEqual(1);
  });
});

describe("computeAgentWallAvoidanceForce (Issue #248 ADR §1.4)", () => {
  it("境界から十分離れていれば寄与は0", () => {
    const force = computeAgentWallAvoidanceForce({ x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 }, CONFIG);
    expect(force.fx).toBe(0);
    expect(force.fy).toBe(0);
  });

  it("左端に近いと内側(+x方向)へ押す", () => {
    const force = computeAgentWallAvoidanceForce({ x: 5, y: WORLD_HEIGHT / 2 }, CONFIG);
    expect(force.fx).toBeGreaterThan(0);
    expect(force.fy).toBe(0);
  });

  it("右端に近いと内側(-x方向)へ押す", () => {
    const force = computeAgentWallAvoidanceForce({ x: WORLD_WIDTH - 5, y: WORLD_HEIGHT / 2 }, CONFIG);
    expect(force.fx).toBeLessThan(0);
  });

  it("角(2辺が同時に近い)では両軸の寄与が合成され対角方向へ押し返される", () => {
    const force = computeAgentWallAvoidanceForce({ x: 2, y: 2 }, CONFIG);
    expect(force.fx).toBeGreaterThan(0);
    expect(force.fy).toBeGreaterThan(0);
  });

  it("寄与はagentWallMaxContributionで頭打ちになる(発散しない)", () => {
    const force = computeAgentWallAvoidanceForce({ x: 0, y: 0 }, CONFIG);
    const magnitude = Math.hypot(force.fx, force.fy);
    expect(magnitude).toBeLessThanOrEqual(CONFIG.agentWallMaxContribution + 1e-9);
  });

  it("NaN/Infinityを発生させない(座標が境界そのもの、または範囲外でも)", () => {
    for (const point of [
      { x: 0, y: 0 },
      { x: WORLD_WIDTH, y: WORLD_HEIGHT },
      { x: -10, y: -10 },
    ]) {
      const force = computeAgentWallAvoidanceForce(point, CONFIG);
      expect(Number.isFinite(force.fx)).toBe(true);
      expect(Number.isFinite(force.fy)).toBe(true);
    }
  });
});

describe("computeRoamingVector (Issue #248 ADR §1.4手順1)", () => {
  it("intensity = 1のとき、大きさはroamingSpeedちょうど", () => {
    const vector = computeRoamingVector(0, 1, CONFIG);
    expect(Math.hypot(vector.dx, vector.dy)).toBeCloseTo(CONFIG.roamingSpeed, 10);
  });

  it("intensity = 0のとき、大きさは0", () => {
    const vector = computeRoamingVector(0, 0, CONFIG);
    expect(vector.dx).toBe(0);
    expect(vector.dy).toBe(0);
  });

  it("headingの向きへ移動する", () => {
    const vector = computeRoamingVector(Math.PI / 2, 1, CONFIG);
    expect(vector.dx).toBeCloseTo(0, 10);
    expect(vector.dy).toBeCloseTo(CONFIG.roamingSpeed, 10);
  });
});

describe("applyAgentRoamingStep (Issue #248 ADR §1.4合成順序)", () => {
  const heading: RoamingState = { headingRadians: 0, expiresAtTick: 100 };

  it("会場中央では合成後の1tick移動量がroamingSpeed以下(壁寄与なし)", () => {
    const agent = makeAgent({ x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 });
    const before = { x: agent.x, y: agent.y };
    applyAgentRoamingStep(agent, heading, 1, CONFIG);
    expect(movementDistance(before, agent)).toBeLessThanOrEqual(CONFIG.roamingSpeed + 1e-9);
  });

  it("intensity = 0でも壁際ならwall avoidance分は移動する(roaming寄与0でも壁からは押し返される)", () => {
    const agent = makeAgent({ x: 2, y: WORLD_HEIGHT / 2 });
    const before = { x: agent.x, y: agent.y };
    applyAgentRoamingStep(agent, heading, 0, CONFIG);
    expect(agent.x).toBeGreaterThan(before.x);
  });

  it("合成vectorはmaxAgentSpeedで頭打ちになる", () => {
    const config = { ...CONFIG, maxAgentSpeed: 0.5 };
    // world境界のclamp範囲[5, W-5]内の位置を使う(境界外の初期位置だと、境界clampによる補正分が
    // 合成vectorのclampと別に加わってしまい、この検証の意図(合成vector自体の頭打ち)とずれるため)
    const agent = makeAgent({ x: 6, y: 6 });
    const before = { x: agent.x, y: agent.y };
    applyAgentRoamingStep(agent, heading, 1, config);
    expect(movementDistance(before, agent)).toBeLessThanOrEqual(config.maxAgentSpeed + 1e-9);
  });

  it("角へ向かい続けてもworld境界外へ出ず、NaN/停止(完全な移動不能)にならない", () => {
    const agent = makeAgent({ x: 6, y: 6 });
    const headingTowardCorner: RoamingState = { headingRadians: (5 * Math.PI) / 4, expiresAtTick: 1000 };
    for (let i = 0; i < 200; i++) {
      applyAgentRoamingStep(agent, headingTowardCorner, 1, CONFIG);
      expect(Number.isFinite(agent.x)).toBe(true);
      expect(Number.isFinite(agent.y)).toBe(true);
      expect(agent.x).toBeGreaterThanOrEqual(5);
      expect(agent.x).toBeLessThanOrEqual(WORLD_WIDTH - 5);
      expect(agent.y).toBeGreaterThanOrEqual(5);
      expect(agent.y).toBeLessThanOrEqual(WORLD_HEIGHT - 5);
    }
  });

  it("会場中央から一定headingで動き続けると、その方向へ実際に変位する(その場で震えるだけにならない)", () => {
    const agent = makeAgent({ x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 });
    const start = { x: agent.x, y: agent.y };
    for (let i = 0; i < 10; i++) {
      applyAgentRoamingStep(agent, heading, 1, CONFIG);
    }
    expect(movementDistance(start, agent)).toBeGreaterThan(CONFIG.roamingSpeed * 5);
  });
});

describe("getRoamingState / roamingTicksRemaining (診断selector, issue実装範囲7節)", () => {
  it("未追跡のagentIdはundefinedを返す", () => {
    expect(getRoamingState({}, "agent-1")).toBeUndefined();
    expect(getRoamingState(undefined, "agent-1")).toBeUndefined();
  });

  it("追跡中のagentIdはそのstateを返す", () => {
    const state: RoamingState = { headingRadians: 1, expiresAtTick: 20 };
    expect(getRoamingState({ "agent-1": state }, "agent-1")).toBe(state);
  });

  it("残りtick数はexpiresAtTick - tick(負にはならない)", () => {
    const state: RoamingState = { headingRadians: 0, expiresAtTick: 10 };
    expect(roamingTicksRemaining(state, 4)).toBe(6);
    expect(roamingTicksRemaining(state, 10)).toBe(0);
    expect(roamingTicksRemaining(state, 15)).toBe(0);
  });
});
