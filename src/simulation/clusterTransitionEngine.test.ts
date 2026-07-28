import { describe, expect, it } from "vitest";
import { stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS } from "./presets";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./model";
import {
  DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
  type StandingPartyScenarioConfig,
} from "./standingPartyScenarioConfig";
import { DEFAULT_CLUSTER_TRANSITION_CONFIG } from "./clusterTransitionDecision";
import type { Agent, GroupCandidate, LogEntry, SimulationState } from "./types";

/**
 * Issue #200 (Phase 3): engine.tsのstep 5b結線(`clusterTransitionDecision.ts`の合成結果を1 drawで
 * actionへ変換する経路)の統合テスト。純粋関数側の性質は`clusterTransitionDecision.test.ts`で
 * 検証済みのため、ここでは「engineが実際にその結果をどう使うか」(byte-identical後方互換、
 * switchToTargetClusterのmetadata、clusterTransitionInhibitedの1エピソード1回制限)に絞る。
 *
 * `currentClusterAttachment.test.ts`の「engine結線」節と同じ方針で、agentは`state: "approaching"`
 * から出発させ、engine自身の合流フロー(`settleIntoGroup`/`startConversationEpisode`)を通して
 * `joined`化・episode初期化させる ―― 最初から`state: "joined"`を直接構築すると`currentEpisode`が
 * 一切初期化されず(`startConversationEpisode`を経由しないため)、後段の愛着・関心計算が
 * 常に中立値に化けてしまう。他memberは`GroupCandidate.memberIds`にのみ載せる「幽霊member」
 * (対応する`Agent`オブジェクトを持たない)にして、容量計算だけに関与させる。
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
    influenceAvoidance: 0,
    conformity: 0.5,
    leaveThreshold: 0.5,
    isObserverJoiner: false,
    state: "approaching",
    stress: 0,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<GroupCandidate>): GroupCandidate {
  return {
    id: "group-a",
    x: 400,
    y: 260,
    memberIds: [],
    status: "confirmed",
    age: 0,
    ...overrides,
  };
}

function makeState(overrides: Partial<SimulationState>): SimulationState {
  return {
    tick: 0,
    agents: [],
    groupCandidates: [],
    log: [],
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    finished: false,
    ...overrides,
  };
}

// Phase 2の離脱圧力を毎tick高く保つ設定(社交的回遊のみで、warmupなしで飽和値まで立ち上がる)。
const HIGH_PRESSURE_DEPARTURE_CONFIG = {
  ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.clusterDeparture,
  minStayTicks: 5,
  maxCirculationContribution: 0.9,
  circulationWarmupTicks: 0,
  circulationRampTicks: 1,
};

/** `SimulationState.log`はtick0からの累積ログ(engine.tsの`log: [...state.log, ...log]`)なので、
 * 最終stateの`.log`をそのまま読めば全tick分のイベントが揃う(tickごとの再結合は不要)。 */
function runTicks(
  state: SimulationState,
  standingPartyConfig: StandingPartyScenarioConfig,
  rng: SeededRandom,
  count: number,
): { state: SimulationState; log: LogEntry[] } {
  let current = state;
  for (let i = 0; i < count; i++) {
    current = stepSimulation(current, DEFAULT_PARAMS, rng, undefined, undefined, undefined, undefined, undefined, {
      scenarioId: "standingParty",
      standingPartyConfig,
    });
  }
  return { state: current, log: current.log };
}

describe("engine結線: transition.enabled=false(既定)は後方互換", () => {
  it("transitionAction/targetClusterId等の新フィールドが一切現れず、clusterTransitionInhibitedも発生しない", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const candidate = makeCandidate({ id: "group-a", memberIds: ["ghost-1"] });
      const agent = makeAgent({
        id: "agent-x",
        state: "approaching",
        joinedGroupId: "group-a",
        x: candidate.x,
        y: candidate.y,
        socialCirculationTendency: 1,
      });
      const state = makeState({ tick: 0, agents: [agent], groupCandidates: [candidate], formationScenarioId: "standingParty" });
      const standingPartyConfig: StandingPartyScenarioConfig = {
        ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
        clusterDeparture: HIGH_PRESSURE_DEPARTURE_CONFIG,
      };
      const rng = new SeededRandom(seed);
      const { log } = runTicks(state, standingPartyConfig, rng, 30);

      for (const entry of log) {
        expect(entry.eventType).not.toBe("clusterTransitionInhibited");
        expect(entry.metadata?.transitionAction).toBeUndefined();
        expect(entry.metadata?.targetClusterId).toBeUndefined();
        expect(entry.metadata?.transitionActionProbabilities).toBeUndefined();
      }
    }
  });
});

describe("engine結線: transition.enabled=true・他クラスタなし", () => {
  it("switchToTargetClusterは一度も選ばれず、離脱は常にdepartAndExploreとして記録される。stayの抑制記録は1エピソード最大1回", () => {
    for (const seed of [11, 12, 13]) {
      const candidate = makeCandidate({ id: "group-a", memberIds: ["ghost-1"] });
      const agent = makeAgent({
        id: "agent-x",
        state: "approaching",
        joinedGroupId: "group-a",
        x: candidate.x,
        y: candidate.y,
        socialCirculationTendency: 1,
      });
      const state = makeState({ tick: 0, agents: [agent], groupCandidates: [candidate], formationScenarioId: "standingParty" });
      const standingPartyConfig: StandingPartyScenarioConfig = {
        ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
        clusterDeparture: HIGH_PRESSURE_DEPARTURE_CONFIG,
        transition: { ...DEFAULT_CLUSTER_TRANSITION_CONFIG, enabled: true },
      };
      const rng = new SeededRandom(seed);
      const { log } = runTicks(state, standingPartyConfig, rng, 60);

      const departures = log.filter((entry) => entry.eventType === "clusterDepartureStarted");
      expect(departures.length).toBeGreaterThan(0);
      for (const entry of departures) {
        expect(entry.metadata?.transitionAction).toBe("departAndExplore");
        expect(entry.metadata?.targetClusterId).toBeUndefined();
        expect(entry.metadata?.alternativeInterestScore).toBeUndefined();
      }

      const inhibited = log.filter((entry) => entry.eventType === "clusterTransitionInhibited");
      const countByEpisode = new Map<string, number>();
      for (const entry of inhibited) {
        const episodeId = entry.metadata?.episodeId ?? "";
        countByEpisode.set(episodeId, (countByEpisode.get(episodeId) ?? 0) + 1);
      }
      for (const count of countByEpisode.values()) {
        expect(count).toBe(1);
      }
    }
  });
});

describe("engine結線: transition.enabled=true・魅力的な他クラスタが近くにある", () => {
  it("switchToTargetClusterが選ばれた場合、targetClusterId等のmetadataが正しく記録される", () => {
    let sawSwitch = false;
    for (const seed of [21, 22, 23, 24, 25, 26, 27, 28]) {
      const clusterA = makeCandidate({ id: "group-a", memberIds: ["ghost-a1"] });
      // group-bはagentと同じ座標(距離0)に置き、距離由来のscoreを最大化する。
      const clusterB = makeCandidate({ id: "group-b", x: clusterA.x, y: clusterA.y, memberIds: ["ghost-b1"] });
      const agent = makeAgent({
        id: "agent-x",
        state: "approaching",
        joinedGroupId: "group-a",
        x: clusterA.x,
        y: clusterA.y,
        socialCirculationTendency: 1,
      });
      const state = makeState({
        tick: 0,
        agents: [agent],
        groupCandidates: [clusterA, clusterB],
        formationScenarioId: "standingParty",
      });
      const standingPartyConfig: StandingPartyScenarioConfig = {
        ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
        clusterDeparture: HIGH_PRESSURE_DEPARTURE_CONFIG,
        attachment: {
          ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.attachment,
          attachmentInhibitionWeight: 0,
          clusterWouldDissolveConcern: 0,
          recentMemberJoinedConcern: 0,
        },
        transition: {
          ...DEFAULT_CLUSTER_TRANSITION_CONFIG,
          enabled: true,
          interestToDepartureGain: 1,
          targetShareBase: 0.9,
          targetShareGain: 0.1,
        },
      };
      const rng = new SeededRandom(seed);
      const { log } = runTicks(state, standingPartyConfig, rng, 60);

      const switched = log.find(
        (entry) => entry.eventType === "clusterDepartureStarted" && entry.metadata?.transitionAction === "switchToTargetCluster",
      );
      if (switched) {
        sawSwitch = true;
        expect(switched.metadata?.targetClusterId).toBe("group-b");
        expect(switched.metadata?.alternativeInterestScore).toBeGreaterThan(0);
        expect(switched.metadata?.transitionActionProbabilities?.switchToTargetCluster).toBeGreaterThan(0);
      }
    }
    expect(sawSwitch).toBe(true);
  });
});

describe("engine結線: 最低滞在tick未達では抑制・関心があってもdrawを引かない", () => {
  it("合流したそのtickはticksInCluster=0でeligibleにならず、joinedのまま", () => {
    const candidate = makeCandidate({ id: "group-a", memberIds: ["ghost-1"] });
    const agent = makeAgent({
      id: "agent-x",
      state: "approaching",
      joinedGroupId: "group-a",
      x: candidate.x,
      y: candidate.y,
    });
    const state = makeState({ tick: 0, agents: [agent], groupCandidates: [candidate], formationScenarioId: "standingParty" });
    const standingPartyConfig: StandingPartyScenarioConfig = {
      ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
      clusterDeparture: HIGH_PRESSURE_DEPARTURE_CONFIG,
      transition: { ...DEFAULT_CLUSTER_TRANSITION_CONFIG, enabled: true },
    };
    const rng = new SeededRandom(99);
    const next = stepSimulation(state, DEFAULT_PARAMS, rng, undefined, undefined, undefined, undefined, undefined, {
      scenarioId: "standingParty",
      standingPartyConfig,
    });
    const updated = next.agents.find((a) => a.id === "agent-x")!;
    expect(updated.state).toBe("joined");
    expect(next.log.some((entry) => entry.eventType === "clusterDepartureStarted")).toBe(false);
  });
});
