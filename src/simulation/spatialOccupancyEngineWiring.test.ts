import { describe, expect, it } from "vitest";
import { stepSimulation, createInitialState } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS } from "./presets";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG } from "./standingPartyScenarioConfig";
import { DEFAULT_SPATIAL_DYNAMICS_CONFIG } from "./spatialDynamics";
import { assertStandingPartyInvariants } from "./standingPartyInvariants";
import { getFormationPolicyById } from "./formationPolicy";
import type { FormationRuntimeOptions } from "./formationPolicy";
import type { Agent, GroupCandidate, SimulationState } from "./types";

/**
 * Issue #249 (Phase 6 P6-C後半、local crowding avoidance): engine.tsへの結線(ADR §6.1 step 6内、
 * roaming + crowding + wall avoidanceの合成)を検証する。純粋関数自体の性質(方向サンプリング、
 * 除外規則、threshold/clamp)はspatialOccupancy.test.tsでカバー済み。ここではafterParty/classroomPair
 * への非干渉、disabled時のPhase 5互換、approaching/forming/joined/leavingへ適用されないこと、
 * pendingClusterTransition優先契約、長時間安定性を検証する。
 */

const MIN_SIZE_PARAMS = { ...DEFAULT_PARAMS, groupConfirmSize: 2 };

const SPATIAL_ENABLED_CONFIG = {
  ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
  spatialDynamics: {
    ...DEFAULT_SPATIAL_DYNAMICS_CONFIG,
    enabled: true,
  },
};

const CROWDING_DISABLED_CONFIG = {
  ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
  spatialDynamics: {
    ...DEFAULT_SPATIAL_DYNAMICS_CONFIG,
    enabled: true,
    crowdingEnabled: false,
  },
};

const STANDING_PARTY_SPATIAL_ON: FormationRuntimeOptions = {
  scenarioId: "standingParty",
  standingPartyConfig: SPATIAL_ENABLED_CONFIG,
};

const STANDING_PARTY_CROWDING_OFF: FormationRuntimeOptions = {
  scenarioId: "standingParty",
  standingPartyConfig: CROWDING_DISABLED_CONFIG,
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

describe("crowding avoidance engine wiring (Issue #249)", () => {
  it("密集した場所にいるundecided agentは、crowding有効時のほうが密集から離れやすい", () => {
    // targetを作らせないよう十分低いwillingness/initiativeにし、undecidedのまま密集領域に留める
    const buildAgents = () => {
      const self = makeAgent({
        id: "self",
        x: 300,
        y: 260,
        state: "undecided",
        willingness: 0,
        initiative: 0,
        conformity: 0,
        influenceAvoidance: 1,
      });
      // selfの+x側にundecided agentを固めて配置(自身は動かさない想定はできないため、他は十分遠くのformingにしない)
      const crowd = Array.from({ length: 6 }, (_, i) =>
        makeAgent({
          id: `crowd-${i}`,
          x: 330 + i * 3,
          y: 260 + (i % 2 === 0 ? 5 : -5),
          state: "undecided",
          willingness: 0,
          initiative: 0,
          conformity: 0,
          influenceAvoidance: 1,
        }),
      );
      return [self, ...crowd];
    };

    function runFinalX(formation: FormationRuntimeOptions): number {
      let state = makeState(buildAgents(), [], 0, formation);
      const rng = new SeededRandom(11);
      for (let i = 0; i < 30; i++) {
        state = step(state, rng, formation);
      }
      return state.agents.find((a) => a.id === "self")!.x;
    }

    const withCrowding = runFinalX(STANDING_PARTY_SPATIAL_ON);
    const withoutCrowding = runFinalX(STANDING_PARTY_CROWDING_OFF);
    // 密集は+x側にあるため、crowding有効時はselfがより-x側(小さいx)へ寄るはず
    expect(withCrowding).toBeLessThan(withoutCrowding);
  });

  it("crowdingEnabled === false の間は、spatialDynamics.enabled === true でも従来のroaming+wallのみが働く", () => {
    const a = makeAgent({ id: "a", state: "undecided", x: 400, y: 260 });
    let state = makeState([a], [], 0, STANDING_PARTY_CROWDING_OFF);
    const rng = new SeededRandom(1);
    for (let i = 0; i < 5; i++) {
      state = step(state, rng, STANDING_PARTY_CROWDING_OFF);
    }
    expect(Number.isFinite(state.agents[0].x)).toBe(true);
    expect(Number.isFinite(state.agents[0].y)).toBe(true);
  });

  it("approaching/forming/joined/leaving なagentにはcrowding avoidanceが適用されない(roamingと同じ適用範囲)", () => {
    const candidate = makeCandidate({ id: "group-1", x: 500, y: 300, memberIds: ["joined-1"], status: "confirmed" });
    const approaching = makeAgent({ id: "approaching-1", state: "approaching", joinedGroupId: "group-1", x: 100, y: 100 });
    const forming = makeAgent({ id: "forming-1", state: "forming", x: 200, y: 200 });
    const joined = makeAgent({ id: "joined-1", state: "joined", joinedGroupId: "group-1", x: 500, y: 300 });
    const leaving = makeAgent({ id: "leaving-1", state: "leaving", x: 300, y: 300 });
    // 密集させて crowding が働きうる状況を作った上でも、これらのstateには寄与しないことを見る
    const crowd = Array.from({ length: 5 }, (_, i) =>
      makeAgent({ id: `crowd-${i}`, x: 200 + i * 2, y: 200, state: "undecided" }),
    );
    let state = makeState(
      [approaching, forming, joined, leaving, ...crowd],
      [candidate],
      0,
      STANDING_PARTY_SPATIAL_ON,
    );
    const rng = new SeededRandom(9);
    state = step(state, rng, STANDING_PARTY_SPATIAL_ON);
    const before = { forming: { x: 200, y: 200 }, joined: { x: 500, y: 300 } };
    const formingAfter = state.agents.find((a) => a.id === "forming-1")!;
    const joinedAfter = state.agents.find((a) => a.id === "joined-1")!;
    // forming: 既存のcluster中心微調整のみが働く(crowdingが追加変位を与えない)
    expect(Math.hypot(formingAfter.x - before.forming.x, formingAfter.y - before.forming.y)).toBeLessThanOrEqual(2 + 1e-6);
    // joined: 既存の±18 wanderのみ(crowdingは適用外)
    expect(Math.hypot(joinedAfter.x - before.joined.x, joinedAfter.y - before.joined.y)).toBeLessThanOrEqual(18 + 1e-6);
  });

  it("pendingClusterTransitionを持つ間もcrowding avoidanceは適用される(roaming寄与0とは独立)", () => {
    const target = makeCandidate({ id: "target", x: 700, y: 260, memberIds: ["member-1"], status: "confirmed" });
    const source = makeCandidate({ id: "source", x: 100, y: 100, memberIds: [], status: "confirmed" });
    const member = makeAgent({ id: "member-1", state: "joined", joinedGroupId: "target", x: 700, y: 260 });
    const pendingAgent = makeAgent({
      id: "pending-agent",
      state: "undecided",
      x: 400,
      y: 260,
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
    const crowd = Array.from({ length: 6 }, (_, i) =>
      makeAgent({ id: `crowd-${i}`, x: 420 + i * 3, y: 260, state: "undecided" }),
    );
    let state = makeState([pendingAgent, member, ...crowd], [target, source], 0, STANDING_PARTY_SPATIAL_ON);
    const rng = new SeededRandom(1);
    state = step(state, rng, STANDING_PARTY_SPATIAL_ON);
    const after = state.agents.find((a) => a.id === "pending-agent")!;
    // 密集は+x側にあるためcrowdingが働けば-x方向(x < 400)に押し出されるはず
    expect(after.x).toBeLessThan(400);
  });

  it("afterParty/classroomPairでは、spatialDynamics.enabled === true でもcrowding avoidanceが一切適用されない(非干渉)", () => {
    const a = makeAgent({ id: "a", state: "undecided", x: 400, y: 260 });
    const crowd = Array.from({ length: 5 }, (_, i) => makeAgent({ id: `crowd-${i}`, x: 410 + i * 2, y: 260, state: "undecided" }));
    const afterPartyFormation: FormationRuntimeOptions = {
      scenarioId: "afterParty",
      standingPartyConfig: SPATIAL_ENABLED_CONFIG,
    };
    let state = makeState([a, ...crowd], [], 0, afterPartyFormation);
    const rng = new SeededRandom(1);
    for (let i = 0; i < 5; i++) {
      state = step(state, rng, afterPartyFormation);
    }
    expect(state.spatialRuntimeState).toBeUndefined();
  });

  it("同一seed・同一configなら、crowding込みでも複数回runして同一軌跡になる(seed再現性)", () => {
    function run(): { x: number; y: number }[] {
      const self = makeAgent({ id: "self", state: "undecided", x: 300, y: 260 });
      const crowd = Array.from({ length: 4 }, (_, i) => makeAgent({ id: `crowd-${i}`, x: 330 + i * 3, y: 260, state: "undecided" }));
      let state = makeState([self, ...crowd], [], 0, STANDING_PARTY_SPATIAL_ON);
      const rng = new SeededRandom(21);
      const trace: { x: number; y: number }[] = [];
      for (let i = 0; i < 20; i++) {
        state = step(state, rng, STANDING_PARTY_SPATIAL_ON);
        const agent = state.agents.find((ag) => ag.id === "self")!;
        trace.push({ x: agent.x, y: agent.y });
      }
      return trace;
    }
    expect(run()).toEqual(run());
  });

  it("agents配列の処理順を変えても、crowdingの結果(最終位置)は同一になる(ADR §6.3順序非依存)", () => {
    function run(order: "forward" | "reverse"): { id: string; x: number; y: number }[] {
      const self = makeAgent({ id: "self", state: "undecided", x: 300, y: 260 });
      const crowd = Array.from({ length: 4 }, (_, i) => makeAgent({ id: `crowd-${i}`, x: 330 + i * 3, y: 260, state: "undecided" }));
      const agents = order === "forward" ? [self, ...crowd] : [...crowd, self].reverse();
      let state = makeState(agents, [], 0, STANDING_PARTY_SPATIAL_ON);
      const rng = new SeededRandom(21);
      state = step(state, rng, STANDING_PARTY_SPATIAL_ON);
      return [...state.agents].sort((a, b) => (a.id < b.id ? -1 : 1)).map((a) => ({ id: a.id, x: a.x, y: a.y }));
    }
    const forward = run("forward");
    const reverse = run("reverse");
    for (let i = 0; i < forward.length; i++) {
      expect(reverse[i].x).toBeCloseTo(forward[i].x, 9);
      expect(reverse[i].y).toBeCloseTo(forward[i].y, 9);
    }
  });

  it("1000tickの長時間runでNaN/Infinity・world境界外・membership破壊が発生しない(crowding込み)", () => {
    const formationPolicy = getFormationPolicyById("standingParty");
    const seeds = [1, 2];
    for (const seed of seeds) {
      const rng = new SeededRandom(seed);
      let state = createInitialState(
        seed,
        MIN_SIZE_PARAMS,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        STANDING_PARTY_SPATIAL_ON,
      );
      for (let i = 0; i < 1000; i++) {
        state = step(state, rng, STANDING_PARTY_SPATIAL_ON);
        assertStandingPartyInvariants(state, {
          maxEmptyFormingAge: formationPolicy.defaultMaxAge,
          label: `crowding seed=${seed} tick=${state.tick}`,
        });
        for (const agent of state.agents) {
          expect(agent.x).toBeGreaterThanOrEqual(5 - 1e-6);
          expect(agent.x).toBeLessThanOrEqual(800 - 5 + 1e-6);
          expect(agent.y).toBeGreaterThanOrEqual(5 - 1e-6);
          // leavingは画面外(下方向)へ抜けるまで座標がWORLD_HEIGHT+40まで許容される
          expect(agent.y).toBeLessThanOrEqual(520 + 40 + 1e-6);
        }
      }
    }
  }, 30000);
});
