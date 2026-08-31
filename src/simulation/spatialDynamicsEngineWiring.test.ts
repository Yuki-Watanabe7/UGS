import { describe, expect, it } from "vitest";
import { stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS } from "./presets";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG } from "./standingPartyScenarioConfig";
import { DEFAULT_SPATIAL_DYNAMICS_CONFIG } from "./spatialDynamics";
import type { FormationRuntimeOptions } from "./formationPolicy";
import type { Agent, GroupCandidate, SimulationState } from "./types";

/**
 * Issue #247 (Phase 6 P6-B): engine.tsへの結線(ADR §6.1 S1〜S4)を検証する。
 * 純粋関数自体の性質(斥力の形、wall avoidance、決定的分離等)はspatialDynamics.test.tsでカバー済み。
 * ここではafterParty/classroomPairへの非干渉、disabled時のPhase 5互換、moving targetへの接近、
 * membership/episode/pendingClusterTransitionが空間phaseで破壊されないことを検証する。
 */

const MIN_SIZE_PARAMS = { ...DEFAULT_PARAMS, groupConfirmSize: 2 };

const SPATIAL_ENABLED_CONFIG = {
  ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
  spatialDynamics: {
    ...DEFAULT_SPATIAL_DYNAMICS_CONFIG,
    enabled: true,
  },
};

const STANDING_PARTY_SPATIAL_ON: FormationRuntimeOptions = {
  scenarioId: "standingParty",
  standingPartyConfig: SPATIAL_ENABLED_CONFIG,
};

const STANDING_PARTY_SPATIAL_OFF: FormationRuntimeOptions = {
  scenarioId: "standingParty",
  standingPartyConfig: DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
};

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

function makeState(
  agents: Agent[],
  candidates: GroupCandidate[],
  tick: number,
  formation: FormationRuntimeOptions,
): SimulationState {
  return {
    tick,
    agents,
    groupCandidates: candidates,
    log: [],
    width: 800,
    height: 520,
    finished: false,
    formationScenarioId: formation.scenarioId,
    standingPartyConfig: formation.standingPartyConfig,
  };
}

function step(state: SimulationState, rng: SeededRandom, formation: FormationRuntimeOptions): SimulationState {
  return stepSimulation(
    state,
    MIN_SIZE_PARAMS,
    rng,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    formation,
  );
}

describe("spatialDynamics engine wiring (Issue #247)", () => {
  it("spatialDynamics.enabled === false の間はconfirmed clusterの中心が一切動かない(既存挙動と一致)", () => {
    const a = makeCandidate({ id: "a", x: 390, y: 260, memberIds: ["m1", "m2"] });
    const b = makeCandidate({ id: "b", x: 410, y: 260, memberIds: ["m3", "m4"] });
    const agents = [
      makeAgent({ id: "m1", state: "joined", joinedGroupId: "a", x: 390, y: 260 }),
      makeAgent({ id: "m2", state: "joined", joinedGroupId: "a", x: 392, y: 260 }),
      makeAgent({ id: "m3", state: "joined", joinedGroupId: "b", x: 410, y: 260 }),
      makeAgent({ id: "m4", state: "joined", joinedGroupId: "b", x: 412, y: 260 }),
    ];
    let state = makeState(agents, [a, b], 0, STANDING_PARTY_SPATIAL_OFF);
    const rng = new SeededRandom(1);
    for (let i = 0; i < 5; i++) {
      state = step(state, rng, STANDING_PARTY_SPATIAL_OFF);
    }
    const [ra, rb] = state.groupCandidates;
    expect(ra.x).toBe(390);
    expect(ra.y).toBe(260);
    expect(rb.x).toBe(410);
    expect(rb.y).toBe(260);
    expect(state.spatialRuntimeState).toBeUndefined();
  });

  it("spatialDynamics.enabled === true では、近接するconfirmed cluster同士が数tickで間隔を広げる", () => {
    const a = makeCandidate({ id: "a", x: 390, y: 260, memberIds: ["m1", "m2"] });
    const b = makeCandidate({ id: "b", x: 410, y: 260, memberIds: ["m3", "m4"] });
    const agents = [
      makeAgent({ id: "m1", state: "joined", joinedGroupId: "a", x: 390, y: 260 }),
      makeAgent({ id: "m2", state: "joined", joinedGroupId: "a", x: 392, y: 260 }),
      makeAgent({ id: "m3", state: "joined", joinedGroupId: "b", x: 410, y: 260 }),
      makeAgent({ id: "m4", state: "joined", joinedGroupId: "b", x: 412, y: 260 }),
    ];
    let state = makeState(agents, [a, b], 0, STANDING_PARTY_SPATIAL_ON);
    const rng = new SeededRandom(1);
    const before = Math.hypot(a.x - b.x, a.y - b.y);
    for (let i = 0; i < 10; i++) {
      state = step(state, rng, STANDING_PARTY_SPATIAL_ON);
    }
    const [ra, rb] = state.groupCandidates;
    const after = Math.hypot(ra.x - rb.x, ra.y - rb.y);
    expect(after).toBeGreaterThan(before);
    expect(state.spatialRuntimeState).toBeDefined();
    expect(state.spatialRuntimeState!.clusterVelocity["a"]).toBeDefined();
  });

  it("afterParty/classroomPairでは、spatialDynamics.enabled === true でもcluster中心が動かない(非干渉)", () => {
    const a = makeCandidate({ id: "a", x: 390, y: 260, memberIds: ["m1"] });
    const b = makeCandidate({ id: "b", x: 410, y: 260, memberIds: ["m2"] });
    const agents = [
      makeAgent({ id: "m1", state: "joined", joinedGroupId: "a", x: 390, y: 260 }),
      makeAgent({ id: "m2", state: "joined", joinedGroupId: "b", x: 410, y: 260 }),
    ];
    const afterPartyFormation: FormationRuntimeOptions = {
      scenarioId: "afterParty",
      standingPartyConfig: SPATIAL_ENABLED_CONFIG,
    };
    let state = makeState(agents, [a, b], 0, afterPartyFormation);
    const rng = new SeededRandom(1);
    for (let i = 0; i < 5; i++) {
      state = step(state, rng, afterPartyFormation);
    }
    const [ra, rb] = state.groupCandidates;
    expect(ra.x).toBe(390);
    expect(rb.x).toBe(410);
    expect(state.spatialRuntimeState).toBeUndefined();
  });

  it("approaching中のagentは、移動するcluster中心へ追従して到達・joinできる", () => {
    // 2つのconfirmed clusterを近接配置し、斥力で"a"が動いていく先を、少し離れた位置から
    // approachingしているagentが追いかけられることを確認する。
    const a = makeCandidate({ id: "a", x: 390, y: 260, memberIds: ["m1"] });
    const b = makeCandidate({ id: "b", x: 410, y: 260, memberIds: ["m2"] });
    const approacher = makeAgent({ id: "approacher", state: "approaching", joinedGroupId: "a", x: 300, y: 260 });
    const agents = [
      makeAgent({ id: "m1", state: "joined", joinedGroupId: "a", x: 390, y: 260 }),
      makeAgent({ id: "m2", state: "joined", joinedGroupId: "b", x: 410, y: 260 }),
      approacher,
    ];
    let state = makeState(agents, [a, b], 0, STANDING_PARTY_SPATIAL_ON);
    const rng = new SeededRandom(7);
    let joined = false;
    for (let i = 0; i < 60 && !joined; i++) {
      state = step(state, rng, STANDING_PARTY_SPATIAL_ON);
      const found = state.agents.find((ag) => ag.id === "approacher");
      if (found?.state === "joined") joined = true;
    }
    expect(joined).toBe(true);
  });

  it("空間phaseはmembership/pendingClusterTransition/currentEpisodeを変更しない", () => {
    const a = makeCandidate({ id: "a", x: 390, y: 260, memberIds: ["m1", "m2"] });
    const b = makeCandidate({ id: "b", x: 410, y: 260, memberIds: ["m3"] });
    const agents = [
      makeAgent({ id: "m1", state: "joined", joinedGroupId: "a", x: 390, y: 260 }),
      makeAgent({ id: "m2", state: "joined", joinedGroupId: "a", x: 392, y: 260 }),
      makeAgent({ id: "m3", state: "joined", joinedGroupId: "b", x: 410, y: 260 }),
    ];
    let state = makeState(agents, [a, b], 0, STANDING_PARTY_SPATIAL_ON);
    const rng = new SeededRandom(3);
    state = step(state, rng, STANDING_PARTY_SPATIAL_ON);

    const membershipById = new Map(state.groupCandidates.map((c) => [c.id, new Set(c.memberIds)]));
    expect(membershipById.get("a")).toEqual(new Set(["m1", "m2"]));
    expect(membershipById.get("b")).toEqual(new Set(["m3"]));
    for (const agent of state.agents) {
      expect(agent.pendingClusterTransition).toBeUndefined();
    }
  });

  it("clusterがdissolveすると、そのvelocity entryはspatialRuntimeStateから消える(cleanup)", () => {
    const a = makeCandidate({ id: "a", x: 390, y: 260, memberIds: ["m1", "m2"], everConfirmed: true });
    // "b"は成立最小人数(2人)を満たした状態で確定させ、velocityが記録された後に1人だけへ減らして解散させる
    const b = makeCandidate({ id: "b", x: 410, y: 260, memberIds: ["m3", "m4"], everConfirmed: true });
    const agents = [
      makeAgent({ id: "m1", state: "joined", joinedGroupId: "a", x: 390, y: 260 }),
      makeAgent({ id: "m2", state: "joined", joinedGroupId: "a", x: 392, y: 260 }),
      makeAgent({ id: "m3", state: "joined", joinedGroupId: "b", x: 410, y: 260 }),
      makeAgent({ id: "m4", state: "joined", joinedGroupId: "b", x: 412, y: 260 }),
    ];
    let state = makeState(agents, [a, b], 0, STANDING_PARTY_SPATIAL_ON);
    const rng = new SeededRandom(11);
    // 1tick進めてvelocityが記録されることを確認してから、bのmemberを1人まで減らし解散へ追い込む
    state = step(state, rng, STANDING_PARTY_SPATIAL_ON);
    expect(state.spatialRuntimeState?.clusterVelocity["b"]).toBeDefined();

    const belowMinSize: SimulationState = {
      ...state,
      groupCandidates: state.groupCandidates.map((c) => (c.id === "b" ? { ...c, memberIds: ["m4"] } : c)),
      agents: state.agents.map((ag) => (ag.id === "m3" ? { ...ag, state: "left" as const, joinedGroupId: undefined } : ag)),
    };
    const afterDissolve = step(belowMinSize, rng, STANDING_PARTY_SPATIAL_ON);
    expect(afterDissolve.spatialRuntimeState?.clusterVelocity["b"]).toBeUndefined();
  });
});
