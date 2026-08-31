import { describe, expect, it } from "vitest";
import { stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS } from "./presets";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG } from "./standingPartyScenarioConfig";
import { DEFAULT_SPATIAL_DYNAMICS_CONFIG } from "./spatialDynamics";
import { getRoamingState } from "./roaming";
import type { FormationRuntimeOptions } from "./formationPolicy";
import type { Agent, GroupCandidate, SimulationState } from "./types";

/**
 * Issue #248 (Phase 6 P6-C相当のうちroaming + agent wall avoidance): engine.tsへの結線
 * (ADR §6.1 step 6の置換)を検証する。純粋関数自体の性質(heading保持、wall avoidance、
 * vector合成)はroaming.test.tsでカバー済み。ここではafterParty/classroomPairへの非干渉、
 * disabled時のPhase 5互換、pendingClusterTransition優先契約、reset時のstate非残存、
 * approaching/forming/joined/leavingへroamingが適用されないことを検証する。
 */

const MIN_SIZE_PARAMS = { ...DEFAULT_PARAMS, groupConfirmSize: 2 };

const SPATIAL_ENABLED_CONFIG = {
  ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
  spatialDynamics: {
    ...DEFAULT_SPATIAL_DYNAMICS_CONFIG,
    enabled: true,
  },
};

const SPATIAL_ENABLED_ROAMING_DISABLED_CONFIG = {
  ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
  spatialDynamics: {
    ...DEFAULT_SPATIAL_DYNAMICS_CONFIG,
    enabled: true,
    roamingEnabled: false,
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

const STANDING_PARTY_ROAMING_OFF: FormationRuntimeOptions = {
  scenarioId: "standingParty",
  standingPartyConfig: SPATIAL_ENABLED_ROAMING_DISABLED_CONFIG,
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
  return stepSimulation(state, MIN_SIZE_PARAMS, rng, undefined, undefined, undefined, undefined, undefined, formation);
}

describe("roaming engine wiring (Issue #248)", () => {
  it("spatialDynamics.enabled === false の間は既存の独立ランダムwalkのまま、roaming stateは記録されない", () => {
    const a = makeAgent({ id: "a", state: "undecided", x: 400, y: 260 });
    let state = makeState([a], [], 0, STANDING_PARTY_SPATIAL_OFF);
    const rng = new SeededRandom(1);
    for (let i = 0; i < 5; i++) {
      state = step(state, rng, STANDING_PARTY_SPATIAL_OFF);
    }
    expect(state.spatialRuntimeState).toBeUndefined();
  });

  it("roamingEnabled === false の間は、spatialDynamics.enabled === trueでもroaming stateが記録されない", () => {
    const a = makeAgent({ id: "a", state: "undecided", x: 400, y: 260 });
    let state = makeState([a], [], 0, STANDING_PARTY_ROAMING_OFF);
    const rng = new SeededRandom(1);
    for (let i = 0; i < 5; i++) {
      state = step(state, rng, STANDING_PARTY_ROAMING_OFF);
    }
    expect(state.spatialRuntimeState?.roaming ?? {}).toEqual({});
  });

  it("spatialDynamics.enabled === true では、undecided agentのroaming stateが記録される", () => {
    const a = makeAgent({ id: "a", state: "undecided", x: 400, y: 260 });
    let state = makeState([a], [], 0, STANDING_PARTY_SPATIAL_ON);
    const rng = new SeededRandom(1);
    state = step(state, rng, STANDING_PARTY_SPATIAL_ON);
    expect(getRoamingState(state.spatialRuntimeState?.roaming, "a")).toBeDefined();
  });

  it("headingが一定期間維持されたまま、agentは会場内を実際に移動していく(その場で震えるだけにならない)", () => {
    const a = makeAgent({ id: "a", state: "undecided", x: 400, y: 260 });
    let state = makeState([a], [], 0, STANDING_PARTY_SPATIAL_ON);
    const rng = new SeededRandom(3);
    const start = { x: a.x, y: a.y };
    for (let i = 0; i < 15; i++) {
      state = step(state, rng, STANDING_PARTY_SPATIAL_ON);
    }
    const moved = state.agents.find((ag) => ag.id === "a")!;
    const displaced = Math.hypot(moved.x - start.x, moved.y - start.y);
    expect(displaced).toBeGreaterThan(1);
  });

  it("agentがworld境界外へ出ず、NaN/Infinityにもならない(長時間run、cornerを含む)", () => {
    const a = makeAgent({ id: "a", state: "undecided", x: 10, y: 10 });
    let state = makeState([a], [], 0, STANDING_PARTY_SPATIAL_ON);
    const rng = new SeededRandom(5);
    for (let i = 0; i < 200; i++) {
      state = step(state, rng, STANDING_PARTY_SPATIAL_ON);
      const agent = state.agents.find((ag) => ag.id === "a")!;
      expect(Number.isFinite(agent.x)).toBe(true);
      expect(Number.isFinite(agent.y)).toBe(true);
      expect(agent.x).toBeGreaterThanOrEqual(5);
      expect(agent.x).toBeLessThanOrEqual(800 - 5);
      expect(agent.y).toBeGreaterThanOrEqual(5);
      expect(agent.y).toBeLessThanOrEqual(520 - 5);
    }
  });

  it("approaching/forming/joined/leaving なagentにはroamingが適用されない(roaming stateも記録されない)", () => {
    const candidate = makeCandidate({ id: "group-1", x: 500, y: 300, memberIds: ["joined-1"], status: "confirmed" });
    const approaching = makeAgent({ id: "approaching-1", state: "approaching", joinedGroupId: "group-1", x: 100, y: 100 });
    const forming = makeAgent({ id: "forming-1", state: "forming", x: 200, y: 200 });
    const joined = makeAgent({ id: "joined-1", state: "joined", joinedGroupId: "group-1", x: 500, y: 300 });
    const leaving = makeAgent({ id: "leaving-1", state: "leaving", x: 300, y: 300 });
    let state = makeState(
      [approaching, forming, joined, leaving],
      [candidate],
      0,
      STANDING_PARTY_SPATIAL_ON,
    );
    const rng = new SeededRandom(9);
    state = step(state, rng, STANDING_PARTY_SPATIAL_ON);
    const roaming = state.spatialRuntimeState?.roaming ?? {};
    expect(getRoamingState(roaming, "approaching-1")).toBeUndefined();
    expect(getRoamingState(roaming, "forming-1")).toBeUndefined();
    expect(getRoamingState(roaming, "joined-1")).toBeUndefined();
    expect(getRoamingState(roaming, "leaving-1")).toBeUndefined();
  });

  it("target候補選択でapprochingへ遷移すると、そのtickのroaming stateからは脱落する(次state)", () => {
    // 十分近い成立済みclusterへ強い意欲で接近を即決させ、undecided -> approachingへ遷移させる
    const candidate = makeCandidate({ id: "group-1", x: 405, y: 260, memberIds: ["m1"], status: "confirmed" });
    const decisive = makeAgent({
      id: "decisive",
      state: "undecided",
      x: 400,
      y: 260,
      willingness: 1,
      conformity: 1,
      influenceAvoidance: 0,
    });
    const member = makeAgent({ id: "m1", state: "joined", joinedGroupId: "group-1", x: 405, y: 260 });
    let state = makeState([decisive, member], [candidate], 0, STANDING_PARTY_SPATIAL_ON);
    const rng = new SeededRandom(2);
    let becameApproaching = false;
    for (let i = 0; i < 20 && !becameApproaching; i++) {
      state = step(state, rng, STANDING_PARTY_SPATIAL_ON);
      const agent = state.agents.find((ag) => ag.id === "decisive")!;
      if (agent.state !== "undecided") {
        becameApproaching = true;
        expect(getRoamingState(state.spatialRuntimeState?.roaming, "decisive")).toBeUndefined();
      }
    }
    expect(becameApproaching).toBe(true);
  });

  it("pendingClusterTransitionを持つ間はroaming寄与が0になる(会場中央では位置が一切変化しない、ADR §3.4)", () => {
    // willingness/initiative/conformity=0・influenceAvoidance=1で接近確率をほぼ0にし、
    // undecidedのままpendingClusterTransitionを保持し続けさせる(targetは容量に余裕がある成立済みcluster)。
    const target = makeCandidate({ id: "target", x: 700, y: 260, memberIds: ["member-1"], status: "confirmed" });
    const source = makeCandidate({ id: "source", x: 100, y: 100, memberIds: [], status: "confirmed" });
    const member = makeAgent({ id: "member-1", state: "joined", joinedGroupId: "target", x: 700, y: 260 });
    const pendingAgent = makeAgent({
      id: "pending-agent",
      state: "undecided",
      x: 400,
      y: 260, // 会場中央、壁から十分離れている(wall avoidance寄与も0)
      willingness: 0,
      initiative: 0,
      conformity: 0,
      influenceAvoidance: 1,
      pendingClusterTransition: {
        targetClusterId: "target",
        sourceClusterId: "source",
        decidedAtTick: 0,
        expiresAtTick: 1000,
        interestScore: 0,
        primaryReason: "alternativeClusterInterest",
      },
    });
    let state = makeState([pendingAgent, member], [target, source], 0, STANDING_PARTY_SPATIAL_ON);
    const rng = new SeededRandom(1);
    let observedHeldTick = false;
    for (let i = 0; i < 20; i++) {
      state = step(state, rng, STANDING_PARTY_SPATIAL_ON);
      const after = state.agents.find((ag) => ag.id === "pending-agent")!;
      if (after.state !== "undecided" || !after.pendingClusterTransition) break;
      expect(after.x).toBe(400);
      expect(after.y).toBe(260);
      observedHeldTick = true;
    }
    expect(observedHeldTick).toBe(true);
  });

  it("pendingClusterTransitionを持っていても、agent側wall avoidanceは引き続き適用される(roaming寄与0とは独立)", () => {
    const target = makeCandidate({ id: "target", x: 700, y: 260, memberIds: ["member-1"], status: "confirmed" });
    const source = makeCandidate({ id: "source", x: 100, y: 100, memberIds: [], status: "confirmed" });
    const member = makeAgent({ id: "member-1", state: "joined", joinedGroupId: "target", x: 700, y: 260 });
    const pendingAgent = makeAgent({
      id: "pending-agent",
      state: "undecided",
      x: 6,
      y: 260, // 左壁のwallAvoidanceDistance(既定40)以内
      willingness: 0,
      initiative: 0,
      conformity: 0,
      influenceAvoidance: 1,
      pendingClusterTransition: {
        targetClusterId: "target",
        sourceClusterId: "source",
        decidedAtTick: 0,
        expiresAtTick: 1000,
        interestScore: 0,
        primaryReason: "alternativeClusterInterest",
      },
    });
    let state = makeState([pendingAgent, member], [target, source], 0, STANDING_PARTY_SPATIAL_ON);
    const rng = new SeededRandom(1);
    state = step(state, rng, STANDING_PARTY_SPATIAL_ON);
    const after = state.agents.find((ag) => ag.id === "pending-agent")!;
    expect(after.state).toBe("undecided");
    expect(after.pendingClusterTransition).toBeDefined();
    expect(after.x).toBeGreaterThan(6);
  });

  it("afterParty/classroomPairでは、spatialDynamics.enabled === true でもroaming stateが一切記録されない(非干渉)", () => {
    const a = makeAgent({ id: "a", state: "undecided", x: 400, y: 260 });
    const afterPartyFormation: FormationRuntimeOptions = {
      scenarioId: "afterParty",
      standingPartyConfig: SPATIAL_ENABLED_CONFIG,
    };
    let state = makeState([a], [], 0, afterPartyFormation);
    const rng = new SeededRandom(1);
    for (let i = 0; i < 5; i++) {
      state = step(state, rng, afterPartyFormation);
    }
    expect(state.spatialRuntimeState).toBeUndefined();
  });

  it("同一seed・同一configなら、複数回runしても同一のroaming軌跡になる(seed再現性)", () => {
    function run(): { x: number; y: number }[] {
      const a = makeAgent({ id: "a", state: "undecided", x: 400, y: 260 });
      let state = makeState([a], [], 0, STANDING_PARTY_SPATIAL_ON);
      const rng = new SeededRandom(21);
      const trace: { x: number; y: number }[] = [];
      for (let i = 0; i < 20; i++) {
        state = step(state, rng, STANDING_PARTY_SPATIAL_ON);
        const agent = state.agents.find((ag) => ag.id === "a")!;
        trace.push({ x: agent.x, y: agent.y });
      }
      return trace;
    }
    expect(run()).toEqual(run());
  });
});
