import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS } from "./presets";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./model";
import {
  DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
  type StandingPartyScenarioConfig,
} from "./standingPartyScenarioConfig";
import { DEFAULT_CLUSTER_TRANSITION_CONFIG } from "./clusterTransitionDecision";
import type { Agent, GroupCandidate, LogEntry, PendingClusterTransition, SimulationState } from "./types";

/**
 * Issue #201 (Phase 3, ステップP3-D): `docs/cluster-transition-phase3-model.md`(Issue #197 ADR)
 * 1.5節・3.3節・3.4節・8.1節で確定した`PendingClusterTransition`のライフサイクル(生成・目的地付き
 * 接近・join時の再検証・無効化・fallback)のテスト。純粋関数の性質(合成式・確率)は
 * `clusterTransitionDecision.test.ts`で、engineのaction抽選結線は`clusterTransitionEngine.test.ts`で
 * 検証済みのため、ここでは「pendingClusterTransitionを持つagentがstep 2/3でどう扱われるか」に絞る。
 *
 * `currentClusterAttachment.test.ts`/`clusterTransitionEngine.test.ts`と同じ方針で、無効化系の
 * テストはagentを最初から`pendingClusterTransition`付きで直接構築する(離脱decisionの確率に
 * 依存させず、目的地付き接近フローだけを決定的に切り出す)。
 */

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-x",
    label: "X",
    x: 100,
    y: 100,
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
    id: "group-target",
    x: 700,
    y: 450,
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
    formationScenarioId: "standingParty",
    ...overrides,
  };
}

function makePendingTransition(overrides: Partial<PendingClusterTransition> = {}): PendingClusterTransition {
  return {
    targetClusterId: "group-target",
    sourceClusterId: "group-source",
    decidedAtTick: 0,
    expiresAtTick: 100,
    interestScore: 0.6,
    primaryReason: "alternativeClusterInterest",
    ...overrides,
  };
}

function step(state: SimulationState, seed = 1): SimulationState {
  const rng = new SeededRandom(seed);
  return stepSimulation(state, DEFAULT_PARAMS, rng, undefined, undefined, undefined, undefined, undefined, {
    scenarioId: "standingParty",
    standingPartyConfig: DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
  });
}

function findEvents(log: LogEntry[], eventType: string): LogEntry[] {
  return log.filter((entry) => entry.eventType === eventType);
}

describe("pendingClusterTransition: 目的地への到着とjoin", () => {
  it("targetへ到着済みなら既存join処理で参加し、clusterTransitionCompletedを記録してpendingを破棄する", () => {
    const source = makeCandidate({ id: "group-source", x: 100, y: 100, memberIds: [] });
    const target = makeCandidate({ id: "group-target", x: 100, y: 100, memberIds: ["ghost-1"] });
    const agent = makeAgent({
      state: "approaching",
      joinedGroupId: "group-target",
      x: 100,
      y: 100,
      pendingClusterTransition: makePendingTransition({ focusAgentId: "ghost-1" }),
    });
    const state = makeState({ agents: [agent], groupCandidates: [source, target] });

    const next = step(state);
    const updated = next.agents.find((a) => a.id === "agent-x")!;

    expect(updated.state).toBe("joined");
    expect(updated.joinedGroupId).toBe("group-target");
    expect(updated.pendingClusterTransition).toBeUndefined();

    const updatedTarget = next.groupCandidates.find((c) => c.id === "group-target")!;
    expect(updatedTarget.memberIds).toContain("agent-x");
    const updatedSource = next.groupCandidates.find((c) => c.id === "group-source")!;
    expect(updatedSource.memberIds).not.toContain("agent-x");

    const completed = findEvents(next.log, "clusterTransitionCompleted");
    expect(completed).toHaveLength(1);
    expect(completed[0].metadata?.targetClusterId).toBe("group-target");
    expect(completed[0].metadata?.focusAgentId).toBe("ghost-1");
    expect(completed[0].metadata?.transitionPrimaryReason).toBe("alternativeClusterInterest");
  });
});

describe("pendingClusterTransition: 満員による無効化(責務5・6)", () => {
  it("到着前にtargetが満員と判明した場合、targetFullとして無効化しfallbackする", () => {
    const source = makeCandidate({ id: "group-source", x: 100, y: 100, memberIds: [] });
    const target = makeCandidate({ id: "group-target", x: 700, y: 450, memberIds: ["ghost-1"], maxGroupSize: 1 });
    const agent = makeAgent({
      state: "approaching",
      joinedGroupId: "group-target",
      x: 100,
      y: 100,
      pendingClusterTransition: makePendingTransition(),
    });
    const state = makeState({ agents: [agent], groupCandidates: [source, target] });

    const next = step(state);
    const updated = next.agents.find((a) => a.id === "agent-x")!;

    expect(updated.state).toBe("undecided");
    expect(updated.joinedGroupId).toBeUndefined();
    expect(updated.pendingClusterTransition).toBeUndefined();

    const invalidated = findEvents(next.log, "clusterTransitionTargetInvalidated");
    expect(invalidated).toHaveLength(1);
    expect(invalidated[0].metadata?.invalidationReason).toBe("targetFull");
    expect(invalidated[0].metadata?.targetClusterId).toBe("group-target");

    expect(findEvents(next.log, "clusterTransitionAbandoned")).toHaveLength(1);
    // 既存の参加失敗経路(責務5: 既存recordApproachFailureのcapacity処理を再利用)もそのまま発生する
    expect(findEvents(next.log, "approachTargetInvalidated")).toHaveLength(1);
  });
});

describe("pendingClusterTransition: targetMissing(責務6)", () => {
  it("targetのcandidateがgroupCandidatesに存在しない場合、targetMissingとして無効化する", () => {
    const source = makeCandidate({ id: "group-source", x: 100, y: 100, memberIds: [] });
    const agent = makeAgent({
      state: "approaching",
      joinedGroupId: "group-target",
      x: 100,
      y: 100,
      pendingClusterTransition: makePendingTransition(),
    });
    const state = makeState({ agents: [agent], groupCandidates: [source] });

    const next = step(state);
    const updated = next.agents.find((a) => a.id === "agent-x")!;

    expect(updated.state).toBe("undecided");
    expect(updated.pendingClusterTransition).toBeUndefined();
    const invalidated = findEvents(next.log, "clusterTransitionTargetInvalidated");
    expect(invalidated).toHaveLength(1);
    expect(invalidated[0].metadata?.invalidationReason).toBe("targetMissing");
  });
});

describe("pendingClusterTransition: targetDissolved(責務6)", () => {
  it("targetがdissolving/expiredの場合、それぞれtargetDissolved/targetExpiredとして無効化する", () => {
    for (const [status, expectedReason] of [
      ["dissolving", "targetDissolved"],
      ["dissolved", "targetDissolved"],
      ["expired", "targetExpired"],
    ] as const) {
      const source = makeCandidate({ id: "group-source", x: 100, y: 100, memberIds: [] });
      const target = makeCandidate({ id: "group-target", x: 700, y: 450, status, memberIds: [] });
      const agent = makeAgent({
        state: "approaching",
        joinedGroupId: "group-target",
        x: 100,
        y: 100,
        pendingClusterTransition: makePendingTransition(),
      });
      const state = makeState({ agents: [agent], groupCandidates: [source, target] });

      const next = step(state);
      const invalidated = findEvents(next.log, "clusterTransitionTargetInvalidated");
      expect(invalidated, `status=${status}`).toHaveLength(1);
      expect(invalidated[0].metadata?.invalidationReason, `status=${status}`).toBe(expectedReason);
    }
  });
});

describe("pendingClusterTransition: focusAgentLeft(責務3・6)", () => {
  it("focusAgentがtargetのmemberIdsに含まれない場合、既存の参加失敗経路を経ずfocusAgentLeftとして無効化する", () => {
    const source = makeCandidate({ id: "group-source", x: 100, y: 100, memberIds: [] });
    const target = makeCandidate({ id: "group-target", x: 700, y: 450, memberIds: ["ghost-other"] });
    const agent = makeAgent({
      state: "approaching",
      joinedGroupId: "group-target",
      x: 100,
      y: 100,
      pendingClusterTransition: makePendingTransition({ focusAgentId: "ghost-focus" }),
    });
    const state = makeState({ agents: [agent], groupCandidates: [source, target] });

    const next = step(state);
    const updated = next.agents.find((a) => a.id === "agent-x")!;

    expect(updated.state).toBe("undecided");
    expect(updated.joinedGroupId).toBeUndefined();
    expect(updated.pendingClusterTransition).toBeUndefined();

    const invalidated = findEvents(next.log, "clusterTransitionTargetInvalidated");
    expect(invalidated).toHaveLength(1);
    expect(invalidated[0].metadata?.invalidationReason).toBe("focusAgentLeft");
    // targetそのものは有効(満員でも消滅でもない)ため、既存の参加失敗イベントは発生しない
    expect(findEvents(next.log, "approachTargetInvalidated")).toHaveLength(0);
  });
});

describe("pendingClusterTransition: TTL超過(責務6)", () => {
  it("tick >= expiresAtTickの場合、target自体は有効でもintentExpiredとして無効化する", () => {
    const source = makeCandidate({ id: "group-source", x: 100, y: 100, memberIds: [] });
    const target = makeCandidate({ id: "group-target", x: 700, y: 450, memberIds: [] });
    const agent = makeAgent({
      state: "approaching",
      joinedGroupId: "group-target",
      x: 100,
      y: 100,
      pendingClusterTransition: makePendingTransition({ expiresAtTick: 1 }),
    });
    const state = makeState({ tick: 0, agents: [agent], groupCandidates: [source, target] });

    const next = step(state);
    const updated = next.agents.find((a) => a.id === "agent-x")!;

    expect(updated.state).toBe("undecided");
    expect(updated.pendingClusterTransition).toBeUndefined();
    const invalidated = findEvents(next.log, "clusterTransitionTargetInvalidated");
    expect(invalidated).toHaveLength(1);
    expect(invalidated[0].metadata?.invalidationReason).toBe("intentExpired");
  });
});

describe("pendingClusterTransition: step 2(undecided)での事前検証", () => {
  it("currentClusterLost(防御的): sourceのcandidateが既に存在しない場合も無効化しfallbackする", () => {
    const target = makeCandidate({ id: "group-target", x: 700, y: 450, memberIds: [] });
    const agent = makeAgent({
      state: "undecided",
      x: 100,
      y: 100,
      pendingClusterTransition: makePendingTransition({ sourceClusterId: "group-source-missing" }),
    });
    const state = makeState({ agents: [agent], groupCandidates: [target] });

    const next = step(state);
    const updated = next.agents.find((a) => a.id === "agent-x")!;

    expect(updated.pendingClusterTransition).toBeUndefined();
    const invalidated = findEvents(next.log, "clusterTransitionTargetInvalidated");
    expect(invalidated).toHaveLength(1);
    expect(invalidated[0].metadata?.invalidationReason).toBe("currentClusterLost");
    expect(findEvents(next.log, "clusterTransitionAbandoned")).toHaveLength(1);
  });

  it("targetFull: undecidedのまま再検証した時点で満員なら、nearestCandidateより先にtargetFullとして無効化する", () => {
    const source = makeCandidate({ id: "group-source", x: 100, y: 100, memberIds: [] });
    const target = makeCandidate({ id: "group-target", x: 700, y: 450, memberIds: ["ghost-1"], maxGroupSize: 1 });
    const agent = makeAgent({
      state: "undecided",
      x: 100,
      y: 100,
      pendingClusterTransition: makePendingTransition(),
    });
    const state = makeState({ agents: [agent], groupCandidates: [source, target] });

    const next = step(state);
    const invalidated = findEvents(next.log, "clusterTransitionTargetInvalidated");
    expect(invalidated).toHaveLength(1);
    expect(invalidated[0].metadata?.invalidationReason).toBe("targetFull");
  });
});

describe("pendingClusterTransition: leaving遷移との相互作用", () => {
  it("会場退出(leaving)へ遷移したagentは移動意図を保持しない", () => {
    const target = makeCandidate({ id: "group-target", x: 700, y: 450, memberIds: [] });
    const agent = makeAgent({
      state: "undecided",
      x: 100,
      y: 100,
      stress: 1,
      leaveThreshold: 0,
      pendingClusterTransition: makePendingTransition(),
    });
    const state = makeState({ agents: [agent], groupCandidates: [target] });

    const next = step(state);
    const updated = next.agents.find((a) => a.id === "agent-x")!;

    expect(updated.state).toBe("leaving");
    expect(updated.pendingClusterTransition).toBeUndefined();
  });
});

describe("pendingClusterTransition: reset", () => {
  it("createInitialStateで生成される新しいagentはpendingClusterTransitionを持たない", () => {
    const state = createInitialState(1, DEFAULT_PARAMS, undefined, undefined, undefined, undefined, undefined, {
      scenarioId: "standingParty",
    });
    expect(state.agents.every((a) => a.pendingClusterTransition === undefined)).toBe(true);
  });
});

// Phase 2の離脱圧力を毎tick高く保つ設定(社交的回遊のみで、warmupなしで飽和値まで立ち上がる)。
// `clusterTransitionEngine.test.ts`と同じ設定値。
const HIGH_PRESSURE_DEPARTURE_CONFIG = {
  ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.clusterDeparture,
  minStayTicks: 5,
  maxCirculationContribution: 0.9,
  circulationWarmupTicks: 0,
  circulationRampTicks: 1,
};

describe("engine結線: switchToTargetCluster確定からjoinまでの一連のフロー", () => {
  it("pendingClusterTransitionが生成されてから実際にjoinするまで、agentはsource/targetいずれのmemberでもない", () => {
    let observedFullCycle = false;
    for (const seed of [21, 22, 23, 24, 25, 26, 27, 28]) {
      const clusterA = makeCandidate({ id: "group-a", x: 400, y: 260, memberIds: ["ghost-a1"] });
      const clusterB = makeCandidate({ id: "group-b", x: clusterA.x, y: clusterA.y, memberIds: ["ghost-b1"] });
      const agent = makeAgent({
        id: "agent-x",
        state: "approaching",
        joinedGroupId: "group-a",
        x: clusterA.x,
        y: clusterA.y,
        socialCirculationTendency: 1,
      });
      let state: SimulationState = makeState({
        tick: 0,
        agents: [agent],
        groupCandidates: [clusterA, clusterB],
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

      let sawPending = false;
      for (let i = 0; i < 80; i++) {
        state = stepSimulation(state, DEFAULT_PARAMS, rng, undefined, undefined, undefined, undefined, undefined, {
          scenarioId: "standingParty",
          standingPartyConfig,
        });

        const a = state.agents.find((ag) => ag.id === "agent-x")!;
        if (a.pendingClusterTransition) {
          sawPending = true;
          // 不変条件(責務10): pending transition中はsource/targetいずれのmemberでもない
          const { sourceClusterId, targetClusterId } = a.pendingClusterTransition;
          for (const c of state.groupCandidates) {
            if (c.id === sourceClusterId || c.id === targetClusterId) {
              expect(c.memberIds).not.toContain("agent-x");
            }
          }
        }

        if (sawPending && state.log.some((entry) => entry.eventType === "clusterTransitionCompleted")) {
          observedFullCycle = true;
          expect(a.pendingClusterTransition).toBeUndefined();
          expect(a.state).toBe("joined");
          expect(state.groupCandidates.find((c) => c.id === "group-b")?.memberIds).toContain("agent-x");
          break;
        }
      }
    }
    expect(observedFullCycle).toBe(true);
  });
});
