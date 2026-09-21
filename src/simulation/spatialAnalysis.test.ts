import { describe, expect, it } from "vitest";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./model";
import { DEFAULT_SPATIAL_DYNAMICS_CONFIG, type SpatialDynamicsConfig } from "./spatialDynamics";
import type { RoamingRuntimeState } from "./roaming";
import {
  SPATIAL_DYNAMICS_ANALYSIS_SCHEMA_VERSION,
  assertSpatialAnalysisDoesNotMutateState,
  buildStandingPartySpatialAnalysis,
} from "./spatialAnalysis";
import type { Agent, GroupCandidate, SimulationState } from "./types";

/**
 * Issue #251 (Phase 6 P6-F): `spatialAnalysis.ts`のread model(境界値・決定性・非mutation)を検証する。
 * engine.tsへの結線を経ずに、`SimulationState`を直接構築したfixtureで検証する(`informationAnalysis.test.ts`
 * 等、既存の分析層テストと同じ方針)。
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

function makeState(agents: Agent[], candidates: GroupCandidate[], roaming: RoamingRuntimeState = {}): SimulationState {
  return {
    tick: 5,
    agents,
    groupCandidates: candidates,
    log: [],
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    finished: false,
    formationScenarioId: "standingParty",
    spatialRuntimeState: { clusterVelocity: {}, roaming },
  };
}

const CONFIG: SpatialDynamicsConfig = { ...DEFAULT_SPATIAL_DYNAMICS_CONFIG, enabled: true };

describe("buildStandingPartySpatialAnalysis: 境界値", () => {
  it("agent0人・cluster0件でも例外を投げず、分布はcount 0・centroid/radiusOfGyrationはundefinedを返す", () => {
    const state = makeState([], []);
    const analysis = buildStandingPartySpatialAnalysis(state, CONFIG);
    expect(analysis.schemaVersion).toBe(SPATIAL_DYNAMICS_ANALYSIS_SCHEMA_VERSION);
    expect(analysis.snapshot.presentAgentCount).toBe(0);
    expect(analysis.snapshot.centroid).toBeUndefined();
    expect(analysis.snapshot.radiusOfGyration).toBeUndefined();
    expect(analysis.snapshot.activeClusterCount).toBe(0);
    expect(analysis.snapshot.clusterNearestNeighborDistance.count).toBe(0);
    expect(analysis.snapshot.clusterOverlapRate.denominator).toBe(0);
    expect(analysis.snapshot.clusterOverlapRate.rate).toBeUndefined();
    expect(analysis.agents).toEqual([]);
    expect(analysis.clusters).toEqual([]);
  });

  it("cluster1件のみでは最近接距離が定義できず、分布count 0のままになる(自分自身以外に対象がない)", () => {
    const state = makeState([], [makeCandidate({ id: "solo", status: "confirmed" })]);
    const analysis = buildStandingPartySpatialAnalysis(state, CONFIG);
    expect(analysis.snapshot.activeClusterCount).toBe(1);
    expect(analysis.snapshot.clusterNearestNeighborDistance.count).toBe(0);
    expect(analysis.clusters).toHaveLength(1);
    expect(analysis.clusters[0].nearestClusterDistance).toBeUndefined();
    expect(analysis.clusters[0].overlapping).toBe(false);
  });

  it("forming/dissolving/dissolved/expiredは活動clusterから除外される(ADR§2.3と同じ対象)", () => {
    const state = makeState(
      [],
      [
        makeCandidate({ id: "a", status: "confirmed", x: 100, y: 100 }),
        makeCandidate({ id: "b", status: "forming", x: 110, y: 100 }),
        makeCandidate({ id: "c", status: "dissolving", x: 105, y: 100 }),
        makeCandidate({ id: "d", status: "dissolved", x: 108, y: 100 }),
        makeCandidate({ id: "e", status: "expired", x: 112, y: 100 }),
      ],
    );
    const analysis = buildStandingPartySpatialAnalysis(state, CONFIG);
    expect(analysis.snapshot.activeClusterCount).toBe(1);
    expect(analysis.clusters.map((c) => c.clusterId)).toEqual(["a"]);
  });

  it("left/unassignedのagentはcentroid/radiusOfGyration/occupancyの分母から除外される", () => {
    const present = makeAgent({ id: "p1", x: 100, y: 100, state: "undecided" });
    const left = makeAgent({ id: "left1", x: 700, y: 500, state: "left" });
    const state = makeState([present, left], []);
    const analysis = buildStandingPartySpatialAnalysis(state, CONFIG);
    expect(analysis.snapshot.presentAgentCount).toBe(1);
    expect(analysis.snapshot.centroid).toEqual({ x: 100, y: 100 });
    expect(analysis.snapshot.radiusOfGyration).toBe(0);
  });
});

describe("buildStandingPartySpatialAnalysis: 計算内容", () => {
  it("2clusterの最近接距離は対称に一致し、overlapThreshold未満ならoverlapping=trueになる", () => {
    const a = makeCandidate({ id: "a", x: 100, y: 100, status: "confirmed" });
    const b = makeCandidate({ id: "b", x: 100 + CONFIG.overlapThreshold - 1, y: 100, status: "confirmed" });
    const state = makeState([], [a, b]);
    const analysis = buildStandingPartySpatialAnalysis(state, CONFIG);
    const clusterA = analysis.clusters.find((c) => c.clusterId === "a")!;
    const clusterB = analysis.clusters.find((c) => c.clusterId === "b")!;
    expect(clusterA.nearestClusterDistance).toBeCloseTo(clusterB.nearestClusterDistance!, 9);
    expect(clusterA.overlapping).toBe(true);
    expect(clusterB.overlapping).toBe(true);
    expect(analysis.snapshot.clusterOverlapRate.numerator).toBe(1);
    expect(analysis.snapshot.clusterOverlapRate.denominator).toBe(1);
    expect(analysis.snapshot.clusterOverlapRate.rate).toBe(1);
  });

  it("radius of gyrationは重心からの距離のRMSと一致する", () => {
    const a1 = makeAgent({ id: "a1", x: 0, y: 0, state: "undecided" });
    const a2 = makeAgent({ id: "a2", x: 10, y: 0, state: "undecided" });
    const state = makeState([a1, a2], []);
    const analysis = buildStandingPartySpatialAnalysis(state, CONFIG);
    expect(analysis.snapshot.centroid).toEqual({ x: 5, y: 0 });
    expect(analysis.snapshot.radiusOfGyration).toBeCloseTo(5, 9);
  });

  it("occupied cell rateは計測専用grid(spatialOccupancy.tsと同一定義)と一致する", () => {
    const a1 = makeAgent({ id: "a1", x: 10, y: 10, state: "undecided" });
    const state = makeState([a1], []);
    const analysis = buildStandingPartySpatialAnalysis(state, CONFIG);
    expect(analysis.snapshot.occupiedCells.numerator).toBe(1);
    expect(analysis.snapshot.occupiedCells.denominator).toBe(40);
  });

  it("roamingRuntimeStateが無いundecided agentはroamingActive=falseになる(まだ確定していない)", () => {
    const agent = makeAgent({ id: "u1", state: "undecided" });
    const state = makeState([agent], []);
    const analysis = buildStandingPartySpatialAnalysis(state, CONFIG);
    const snapshot = analysis.agents.find((a) => a.agentId === "u1")!;
    expect(snapshot.roamingActive).toBe(false);
    expect(snapshot.instantRoamingSpeed).toBeUndefined();
  });

  it("roamingRuntimeStateがあるundecided agentはroamingActive=trueになり、instantRoamingSpeedが定義される", () => {
    const agent = makeAgent({ id: "u1", state: "undecided" });
    const state = makeState([agent], [], { u1: { headingRadians: 0, expiresAtTick: 20 } });
    const analysis = buildStandingPartySpatialAnalysis(state, CONFIG);
    const snapshot = analysis.agents.find((a) => a.agentId === "u1")!;
    expect(snapshot.roamingActive).toBe(true);
    expect(snapshot.roamingHeadingRadians).toBe(0);
    expect(snapshot.roamingTicksRemaining).toBe(15);
    expect(snapshot.instantRoamingSpeed).toBeGreaterThan(0);
  });

  it("pendingClusterTransitionを保持するagentはroaming寄与が0になる(ADR§3.4)", () => {
    const agent = makeAgent({
      id: "u1",
      state: "undecided",
      pendingClusterTransition: {
        sourceClusterId: "a",
        targetClusterId: "b",
        decidedAtTick: 0,
        expiresAtTick: 100,
        interestScore: 0.5,
        primaryReason: "alternativeClusterInterest",
      },
    });
    const state = makeState([agent], [], { u1: { headingRadians: 0, expiresAtTick: 20 } });
    const analysis = buildStandingPartySpatialAnalysis(state, CONFIG);
    const snapshot = analysis.agents.find((a) => a.agentId === "u1")!;
    expect(snapshot.roamingIntensity).toBe(0);
    expect(snapshot.instantRoamingSpeed).toBe(0);
  });

  it("spatialDynamicsEnabled=falseならroamingActiveは常にfalseになる", () => {
    const agent = makeAgent({ id: "u1", state: "undecided" });
    const state = makeState([agent], [], { u1: { headingRadians: 0, expiresAtTick: 20 } });
    const disabledConfig: SpatialDynamicsConfig = { ...CONFIG, enabled: false };
    const analysis = buildStandingPartySpatialAnalysis(state, disabledConfig);
    expect(analysis.spatialDynamicsEnabled).toBe(false);
    expect(analysis.agents[0].roamingActive).toBe(false);
  });

  it("afterPartyシナリオではspatialDynamicsEnabledが常にfalseになる(非干渉)", () => {
    const agent = makeAgent({ id: "u1", state: "undecided" });
    const state: SimulationState = { ...makeState([agent], []), formationScenarioId: "afterParty" };
    const analysis = buildStandingPartySpatialAnalysis(state, CONFIG);
    expect(analysis.spatialDynamicsEnabled).toBe(false);
  });
});

describe("buildStandingPartySpatialAnalysis: filter", () => {
  it("agentIdsで絞り込める", () => {
    const a1 = makeAgent({ id: "a1", state: "undecided" });
    const a2 = makeAgent({ id: "a2", state: "undecided" });
    const state = makeState([a1, a2], []);
    const analysis = buildStandingPartySpatialAnalysis(state, CONFIG, { agentIds: ["a1"] });
    expect(analysis.agents.map((a) => a.agentId)).toEqual(["a1"]);
  });

  it("clusterIdsで絞り込める", () => {
    const c1 = makeCandidate({ id: "c1", x: 100, y: 100 });
    const c2 = makeCandidate({ id: "c2", x: 200, y: 100 });
    const state = makeState([], [c1, c2]);
    const analysis = buildStandingPartySpatialAnalysis(state, CONFIG, { clusterIds: ["c1"] });
    expect(analysis.clusters.map((c) => c.clusterId)).toEqual(["c1"]);
  });

  it("observerJoinerMode: onlyで絞り込める", () => {
    const a1 = makeAgent({ id: "a1", isObserverJoiner: true, state: "undecided" });
    const a2 = makeAgent({ id: "a2", isObserverJoiner: false, state: "undecided" });
    const state = makeState([a1, a2], []);
    const analysis = buildStandingPartySpatialAnalysis(state, CONFIG, { observerJoinerMode: "only" });
    expect(analysis.agents.map((a) => a.agentId)).toEqual(["a1"]);
  });
});

describe("buildStandingPartySpatialAnalysis: 決定性・非mutation", () => {
  it("同一入力からは同一結果を返す(決定的)", () => {
    const agents = [makeAgent({ id: "a1", x: 12, y: 34, state: "undecided" })];
    const candidates = [makeCandidate({ id: "c1", x: 56, y: 78 })];
    const state = makeState(agents, candidates, { a1: { headingRadians: 1.2, expiresAtTick: 30 } });
    const first = buildStandingPartySpatialAnalysis(state, CONFIG);
    const second = buildStandingPartySpatialAnalysis(state, CONFIG);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("SimulationStateをmutationしない", () => {
    const agents = [makeAgent({ id: "a1", x: 12, y: 34, state: "undecided" })];
    const candidates = [makeCandidate({ id: "c1", x: 56, y: 78 })];
    const state = makeState(agents, candidates, { a1: { headingRadians: 1.2, expiresAtTick: 30 } });
    expect(() => assertSpatialAnalysisDoesNotMutateState(state, () => buildStandingPartySpatialAnalysis(state, CONFIG))).not.toThrow();
  });

  it("候補配列の順序に依存しない", () => {
    const candidates = [
      makeCandidate({ id: "a", x: 100, y: 100 }),
      makeCandidate({ id: "b", x: 200, y: 100 }),
      makeCandidate({ id: "c", x: 300, y: 100 }),
    ];
    const state1 = makeState([], candidates);
    const state2 = makeState([], [...candidates].reverse());
    const analysis1 = buildStandingPartySpatialAnalysis(state1, CONFIG);
    const analysis2 = buildStandingPartySpatialAnalysis(state2, CONFIG);
    expect(analysis1.snapshot.clusterNearestNeighborDistance).toEqual(analysis2.snapshot.clusterNearestNeighborDistance);
    expect([...analysis1.clusters].sort((x, y) => x.clusterId.localeCompare(y.clusterId))).toEqual(
      [...analysis2.clusters].sort((x, y) => x.clusterId.localeCompare(y.clusterId)),
    );
  });
});
