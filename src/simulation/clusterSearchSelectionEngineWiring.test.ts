import { describe, expect, it } from "vitest";
import { stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS } from "./presets";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./model";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG, type StandingPartyScenarioConfig } from "./standingPartyScenarioConfig";
import { DEFAULT_SPATIAL_DYNAMICS_CONFIG } from "./spatialDynamics";
import type { FormationRuntimeOptions } from "./formationPolicy";
import type { Agent, GroupCandidate, PendingClusterTransition, SimulationState } from "./types";

/**
 * Issue #250 (Phase 6 P6-D): engine.tsへの結線(step 2でnearestCandidate()から一般化selectionへ
 * 差し替える箇所)を検証する。純粋関数自体の性質(score contract、argmax、cooldown/crowding penalty)は
 * `clusterSearchSelection.test.ts`でカバー済み。ここでは
 * - pendingClusterTransitionの優先契約が一般化selection有効時も維持されること(§5.5)
 * - target無効化後は一般化selectionへfallbackすること
 * - `candidateSelectionEnabled`有効時、最寄りではなく高scoreの候補へ接近できること
 * - `minCandidateScore`未満なら候補があってもroamingを継続する(approachingへ遷移しない)こと
 * - `candidateSelectionEnabled: false`(既定)ならnearestCandidate()の既存挙動と一致すること
 * - afterParty/classroomPairへは一切適用されないこと(非干渉)
 * を検証する。
 */

const HIGH_APPROACH_PARAMS = { ...DEFAULT_PARAMS, existingTieStrength: 0.9 };

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-x",
    label: "X",
    x: 400,
    y: 260,
    vx: 0,
    vy: 0,
    willingness: 1,
    initiative: 0.3,
    ambiguityTolerance: 0.5,
    influenceAvoidance: 0,
    conformity: 1,
    leaveThreshold: 0.9,
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

function makeState(agents: Agent[], candidates: GroupCandidate[], formation: FormationRuntimeOptions): SimulationState {
  return {
    tick: 0,
    agents,
    groupCandidates: candidates,
    log: [],
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    finished: false,
    formationScenarioId: formation.scenarioId,
    standingPartyConfig: formation.standingPartyConfig,
  };
}

function withSpatialConfig(overrides: Partial<StandingPartyScenarioConfig["spatialDynamics"]>): FormationRuntimeOptions {
  return {
    scenarioId: "standingParty",
    standingPartyConfig: {
      ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
      spatialDynamics: { ...DEFAULT_SPATIAL_DYNAMICS_CONFIG, enabled: true, ...overrides },
    },
  };
}

function step(state: SimulationState, formation: FormationRuntimeOptions, seed = 1, params = HIGH_APPROACH_PARAMS): SimulationState {
  const rng = new SeededRandom(seed);
  return stepSimulation(state, params, rng, undefined, undefined, undefined, undefined, undefined, formation);
}

/** 決定的に「approaching」へ遷移するまで、または上限tickまでstepを繰り返す */
function runUntilApproaching(
  state: SimulationState,
  formation: FormationRuntimeOptions,
  agentId: string,
  maxTicks = 30,
  params = HIGH_APPROACH_PARAMS,
): SimulationState {
  let current = state;
  for (let i = 0; i < maxTicks; i++) {
    current = step(current, formation, i + 1, params);
    const agent = current.agents.find((a) => a.id === agentId);
    if (agent && agent.state !== "undecided") return current;
  }
  return current;
}

/** confirmedなcandidateが0人になった瞬間に即座に消滅する既存挙動(責務9)を避けるため、
 * テスト用candidateには必ず既存memberを1人以上添える。 */
function makeMember(id: string, x: number, y: number, groupId: string, overrides: Partial<Agent> = {}): Agent {
  return makeAgent({ id, x, y, state: "joined", joinedGroupId: groupId, clusterJoinedAtTick: 0, ...overrides });
}

describe("clusterSearchSelection engine wiring", () => {
  it("pendingClusterTransitionはcandidateSelectionEnabled時も最優先される(近くの高score候補を無視する)", () => {
    const pending: PendingClusterTransition = {
      targetClusterId: "far-target",
      sourceClusterId: "source",
      decidedAtTick: 0,
      expiresAtTick: 100,
      interestScore: 0.6,
      primaryReason: "alternativeClusterInterest",
    };
    const agent = makeAgent({ x: 0, y: 0, pendingClusterTransition: pending });
    const source = makeCandidate({ id: "source", x: 400, y: 260, memberIds: ["source-member"] });
    const nearDecoy = makeCandidate({ id: "near-decoy", x: 20, y: 0, memberIds: ["near-member"] });
    const farTarget = makeCandidate({ id: "far-target", x: 500, y: 0, memberIds: ["far-member"] });
    const sourceMember = makeMember("source-member", 400, 260, "source");
    const nearMember = makeMember("near-member", 20, 0, "near-decoy");
    const farMember = makeMember("far-member", 500, 0, "far-target");
    const formation = withSpatialConfig({ candidateSelectionEnabled: true });
    const state = makeState([agent, sourceMember, nearMember, farMember], [source, nearDecoy, farTarget], formation);

    const result = runUntilApproaching(state, formation, agent.id);
    const finalAgent = result.agents.find((a) => a.id === agent.id)!;
    expect(finalAgent.state).not.toBe("undecided");
    expect(finalAgent.joinedGroupId).toBe("far-target");
  });

  it("target無効化後は一般化selectionへfallbackする(nearestCandidateではなく総合score最大を選ぶ)", () => {
    // 遠いが同clique(既存関係性による同clique bonus)で魅力度が高いcluster、近いが無関係のclusterを用意し、
    // 一般化selectionがtarget失効直後のtickで前者を選べることを確認する。
    const invalidPending: PendingClusterTransition = {
      targetClusterId: "already-gone",
      sourceClusterId: "source",
      decidedAtTick: 0,
      expiresAtTick: 100,
      interestScore: 0.6,
      primaryReason: "alternativeClusterInterest",
    };
    const agent = makeAgent({ x: 0, y: 0, cliqueId: 1, pendingClusterTransition: invalidPending });
    const nearNeutral = makeCandidate({ id: "near-neutral", x: 20, y: 0, memberIds: ["m1"] });
    const farCliqueMate = makeCandidate({ id: "far-clique-mate", x: 240, y: 0, memberIds: ["m2"] });
    const cliqueMate = makeAgent({ id: "m2", cliqueId: 1, x: 240, y: 0, state: "joined", joinedGroupId: "far-clique-mate" });
    const neutralMember = makeAgent({ id: "m1", cliqueId: 2, x: 20, y: 0, state: "joined", joinedGroupId: "near-neutral" });
    const formation = withSpatialConfig({ candidateSelectionEnabled: true, candidateSelectionObservationRadius: 400 });
    const state = makeState([agent, cliqueMate, neutralMember], [nearNeutral, farCliqueMate], formation);

    const result = runUntilApproaching(state, formation, agent.id);
    const finalAgent = result.agents.find((a) => a.id === agent.id)!;
    expect(finalAgent.state).not.toBe("undecided");
    expect(finalAgent.joinedGroupId).toBe("far-clique-mate");
  });

  it("minCandidateScore未満なら候補があってもroamingを継続する(approachingへ遷移しない)", () => {
    const agent = makeAgent({ x: 0, y: 0, willingness: 0.01, conformity: 0.01, influenceAvoidance: 1 });
    const candidate = makeCandidate({ id: "weak", x: 30, y: 0, status: "forming" });
    const formation = withSpatialConfig({ candidateSelectionEnabled: true, candidateSelectionMinScore: 0.99 });
    const state = makeState([agent], [candidate], formation);

    const result = runUntilApproaching(state, formation, agent.id, 10);
    const finalAgent = result.agents.find((a) => a.id === agent.id)!;
    expect(finalAgent.state).toBe("undecided");
  });

  it("candidateSelectionEnabled: false(既定)ならnearestCandidate()と同じ最寄り優先の挙動を保つ", () => {
    const agent = makeAgent({ x: 0, y: 0 });
    const near = makeCandidate({ id: "near", x: 20, y: 0, memberIds: ["near-member"] });
    const far = makeCandidate({ id: "far", x: 300, y: 0, memberIds: ["far-member"] });
    const nearMember = makeMember("near-member", 20, 0, "near");
    const farMember = makeMember("far-member", 300, 0, "far");
    const formation = withSpatialConfig({ candidateSelectionEnabled: false });
    const state = makeState([agent, nearMember, farMember], [near, far], formation);

    const result = runUntilApproaching(state, formation, agent.id);
    const finalAgent = result.agents.find((a) => a.id === agent.id)!;
    expect(finalAgent.state).not.toBe("undecided");
    expect(finalAgent.joinedGroupId).toBe("near");
  });

  it("afterPartyへは一般化selectionを適用しない(formationPolicy.idゲート)", () => {
    const agent = makeAgent({ x: 0, y: 0 });
    const near = makeCandidate({ id: "near", x: 20, y: 0, memberIds: ["near-member"] });
    const far = makeCandidate({ id: "far", x: 300, y: 0, memberIds: ["far-member"] });
    const nearMember = makeMember("near-member", 20, 0, "near");
    const farMember = makeMember("far-member", 300, 0, "far");
    const formation: FormationRuntimeOptions = { scenarioId: "afterParty" };
    const state: SimulationState = {
      tick: 0,
      agents: [agent, nearMember, farMember],
      groupCandidates: [near, far],
      log: [],
      width: WORLD_WIDTH,
      height: WORLD_HEIGHT,
      finished: false,
      formationScenarioId: "afterParty",
    };

    const result = runUntilApproaching(state, formation, agent.id);
    const finalAgent = result.agents.find((a) => a.id === agent.id)!;
    expect(finalAgent.state).not.toBe("undecided");
    expect(finalAgent.joinedGroupId).toBe("near");
  });
});
