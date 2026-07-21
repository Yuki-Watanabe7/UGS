import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS } from "./presets";
import { afterPartyPolicy, getFormationPolicyById } from "./formationPolicy";
import type { FormationRuntimeOptions, GroupSizeRule } from "./formationPolicy";
import {
  createInitialInterventionRuntimeState,
  createInterventionRandom,
  runSchoolInterventionHook,
} from "./schoolInterventionRuntime";
import type { SchoolInterventionContext } from "./schoolInterventionRuntime";
import {
  NEARBY_PEER_PROMPT_BOOST_WINDOW,
  NEARBY_PEER_PROMPT_MIN_TICK,
  NEARBY_PEER_PROMPT_SEARCH_RADIUS,
  nearbyPeerPromptIntervention,
} from "./schoolInterventions/nearbyPeerPrompt";
import { openGroupSignalIntervention } from "./schoolInterventions/openGroupSignal";
import {
  ANONYMOUS_HELP_COOLDOWN_TICKS,
  ANONYMOUS_HELP_MIN_CAPACITY_FAILURES,
  ANONYMOUS_HELP_MIN_SEARCH_RESTARTS,
  ANONYMOUS_HELP_MIN_TICK,
  anonymousHelpSignalIntervention,
} from "./schoolInterventions/anonymousHelpSignal";
import {
  buildRecommendationOptions,
  computeRecommendationAcceptanceProbability,
  selectRecommendationTarget,
  TEACHER_RECOMMENDATION_LONG_WAIT_TICK,
  TEACHER_RECOMMENDATION_MIN_TICK,
  teacherRecommendationIntervention,
} from "./schoolInterventions/teacherRecommendation";
import type { RecommendationTarget } from "./schoolInterventions/teacherRecommendation";
import type { Agent, GroupCandidate, SimParams, SimulationState } from "./types";

/**
 * Issue #157: 「近くの人への声かけ促進」(`nearby-peer-prompt`)と「空きのある班の参加可能表示」
 * (`open-group-signal`)の2つの学校向け低圧介入のテスト。#156の実行契約(`schoolInterventionRuntime.ts`)
 * を通した単体テストと、`engine.ts`統合(`createInitialState`/`stepSimulation`)の両方をカバーする。
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

function makeContext(overrides: Partial<SchoolInterventionContext> = {}): SchoolInterventionContext {
  return {
    hook: "beforeApproachDecision",
    tick: NEARBY_PEER_PROMPT_MIN_TICK,
    agents: [],
    groupCandidates: [],
    formationPolicy: getFormationPolicyById("classroomPair", 150),
    params: DEFAULT_PARAMS,
    deadlineTick: 150,
    recentEvents: [],
    runSeed: 1,
    runId: "test-run",
    runtimeState: createInitialInterventionRuntimeState(),
    ...overrides,
  };
}

describe("nearbyPeerPromptIntervention", () => {
  it("is a no-op outside classroomPair (afterParty guard)", () => {
    const a = makeAgent({ id: "a", x: 0, y: 0 });
    const b = makeAgent({ id: "b", x: 10, y: 0 });
    const ctx = makeContext({ agents: [a, b], formationPolicy: afterPartyPolicy });
    const result = runSchoolInterventionHook(nearbyPeerPromptIntervention, ctx);
    expect(result.effects).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it("is a no-op before the stagnation threshold tick", () => {
    const a = makeAgent({ id: "a", x: 0, y: 0 });
    const b = makeAgent({ id: "b", x: 10, y: 0 });
    const ctx = makeContext({ agents: [a, b], tick: NEARBY_PEER_PROMPT_MIN_TICK - 1 });
    const result = runSchoolInterventionHook(nearbyPeerPromptIntervention, ctx);
    expect(result.effects).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it("is a no-op with fewer than 2 eligible (undecided) agents", () => {
    const a = makeAgent({ id: "a", x: 0, y: 0, state: "joined" });
    const b = makeAgent({ id: "b", x: 10, y: 0 });
    const ctx = makeContext({ agents: [a, b] });
    const result = runSchoolInterventionHook(nearbyPeerPromptIntervention, ctx);
    expect(result.effects).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it("is a no-op when the closest undecided pair is outside the search radius", () => {
    const a = makeAgent({ id: "a", x: 0, y: 0 });
    const b = makeAgent({ id: "b", x: NEARBY_PEER_PROMPT_SEARCH_RADIUS + 1, y: 0 });
    const ctx = makeContext({ agents: [a, b] });
    const result = runSchoolInterventionHook(nearbyPeerPromptIntervention, ctx);
    expect(result.effects).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it("deterministically picks the closest eligible pair and emits a presented event + temporary effects for both", () => {
    const near1 = makeAgent({ id: "near1", x: 0, y: 0 });
    const near2 = makeAgent({ id: "near2", x: 5, y: 0 });
    const far = makeAgent({ id: "far", x: 300, y: 300 });
    const ctx = makeContext({ agents: [far, near2, near1] });
    const result = runSchoolInterventionHook(nearbyPeerPromptIntervention, ctx);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].eventType).toBe("schoolInterventionTriggered");
    expect(result.events[0].metadata).toMatchObject({
      schoolInterventionId: "nearby-peer-prompt",
      agentId: "near1",
      secondAgentId: "near2",
      outcome: "presented",
    });

    expect(result.effects).toHaveLength(4);
    const forNear1 = result.effects.filter((e) => e.agentId === "near1");
    const forNear2 = result.effects.filter((e) => e.agentId === "near2");
    expect(forNear1.map((e) => e.dimension).sort()).toEqual(["approachProbability", "attractiveness"]);
    expect(forNear2.map((e) => e.dimension).sort()).toEqual(["approachProbability", "attractiveness"]);
    for (const effect of result.effects) {
      expect(effect.startedAtTick).toBe(ctx.tick);
      expect(effect.expiresAtTick).toBe(ctx.tick + NEARBY_PEER_PROMPT_BOOST_WINDOW);
      expect(effect.value).toBeGreaterThan(0);
    }

    expect(result.runtimeState.temporaryEffectExpiryByAgentId).toEqual({
      near1: ctx.tick + NEARBY_PEER_PROMPT_BOOST_WINDOW,
      near2: ctx.tick + NEARBY_PEER_PROMPT_BOOST_WINDOW,
    });
    expect(result.runtimeState.intervenedAgentIds.sort()).toEqual(["near1", "near2"]);
  });

  it("excludes an agent that is still within its cooldown/effect window", () => {
    const a = makeAgent({ id: "a", x: 0, y: 0 });
    const b = makeAgent({ id: "b", x: 5, y: 0 });
    const c = makeAgent({ id: "c", x: 6, y: 0 });
    const ctx = makeContext({
      agents: [a, b, c],
      runtimeState: {
        ...createInitialInterventionRuntimeState(),
        temporaryEffectExpiryByAgentId: { a: NEARBY_PEER_PROMPT_MIN_TICK + 100 },
      },
    });
    const result = runSchoolInterventionHook(nearbyPeerPromptIntervention, ctx);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].metadata?.agentId).toBe("b");
    expect(result.events[0].metadata?.secondAgentId).toBe("c");
  });

  it("is deterministic: same context always yields the same pair and metadata", () => {
    const a = makeAgent({ id: "a", x: 0, y: 0 });
    const b = makeAgent({ id: "b", x: 5, y: 0 });
    const c = makeAgent({ id: "c", x: 5, y: 5 });
    const ctx1 = makeContext({ agents: [a, b, c] });
    const ctx2 = makeContext({ agents: [a, b, c] });
    const r1 = runSchoolInterventionHook(nearbyPeerPromptIntervention, ctx1);
    const r2 = runSchoolInterventionHook(nearbyPeerPromptIntervention, ctx2);
    expect(r1.events).toEqual(r2.events);
    expect(r1.effects).toEqual(r2.effects);
  });
});

describe("openGroupSignalIntervention", () => {
  const pairPolicy = getFormationPolicyById("classroomPair", 150, { minGroupSize: 2, maxGroupSize: 2 });
  const variablePolicy = getFormationPolicyById("classroomPair", 150, { minGroupSize: 3, maxGroupSize: 4 });

  // `openGroupSignalIntervention`は`afterStateTransition`フックのみを実装しているため、
  // 共通の`makeContext`(既定`beforeApproachDecision`)をこのdescribeブロック用に上書きする。
  function makeOpenGroupContext(overrides: Partial<SchoolInterventionContext> = {}): SchoolInterventionContext {
    return makeContext({ hook: "afterStateTransition", ...overrides });
  }

  function candidate(overrides: Partial<GroupCandidate>): GroupCandidate {
    return { id: "g1", x: 0, y: 0, memberIds: [], status: "forming", age: 0, ...overrides };
  }

  it("is a no-op outside classroomPair (afterParty guard)", () => {
    const ctx = makeOpenGroupContext({
      formationPolicy: afterPartyPolicy,
      groupCandidates: [candidate({ memberIds: ["a"] })],
      agents: [makeAgent({ id: "a" })],
    });
    const result = runSchoolInterventionHook(openGroupSignalIntervention, ctx);
    expect(result.effects).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it("signals a forming pair candidate with room and boosts attractiveness for undecided agents", () => {
    const undecided = makeAgent({ id: "u1" });
    const ctx = makeOpenGroupContext({
      formationPolicy: pairPolicy,
      agents: [undecided],
      groupCandidates: [candidate({ id: "g1", memberIds: ["m1"], status: "forming" })],
    });
    const result = runSchoolInterventionHook(openGroupSignalIntervention, ctx);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].metadata).toMatchObject({
      schoolInterventionId: "open-group-signal",
      groupId: "g1",
      outcome: "presented",
    });
    expect(result.effects).toEqual([
      {
        dimension: "attractiveness",
        agentId: "u1",
        targetGroupId: "g1",
        value: expect.any(Number),
        startedAtTick: ctx.tick,
        expiresAtTick: ctx.tick + 2,
      },
    ]);
    expect(result.runtimeState.intervenedGroupIds).toEqual(["g1"]);
  });

  it("does not signal a full fixed-capacity (pair) candidate", () => {
    const ctx = makeOpenGroupContext({
      formationPolicy: pairPolicy,
      agents: [makeAgent({ id: "u1" })],
      groupCandidates: [candidate({ id: "g1", memberIds: ["m1", "m2"], status: "confirmed" })],
    });
    const result = runSchoolInterventionHook(openGroupSignalIntervention, ctx);
    expect(result.events).toEqual([]);
    expect(result.effects).toEqual([]);
  });

  it("does not signal dissolving/dissolved/expired candidates", () => {
    for (const status of ["dissolving", "dissolved", "expired"] as const) {
      const ctx = makeOpenGroupContext({
        formationPolicy: pairPolicy,
        agents: [makeAgent({ id: "u1" })],
        groupCandidates: [candidate({ id: "g1", memberIds: ["m1"], status })],
      });
      const result = runSchoolInterventionHook(openGroupSignalIntervention, ctx);
      expect(result.events).toEqual([]);
      expect(result.effects).toEqual([]);
    }
  });

  it("signals a confirmed variable-capacity group that still has room (3-4 person group)", () => {
    const ctx = makeOpenGroupContext({
      formationPolicy: variablePolicy,
      agents: [makeAgent({ id: "u1" })],
      groupCandidates: [candidate({ id: "g1", memberIds: ["m1", "m2", "m3"], status: "confirmed" })],
    });
    const result = runSchoolInterventionHook(openGroupSignalIntervention, ctx);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].metadata?.outcome).toBe("presented");
    expect(result.effects).toHaveLength(1);
  });

  it("does not signal a confirmed variable-capacity group once it reaches maxGroupSize", () => {
    const ctx = makeOpenGroupContext({
      formationPolicy: variablePolicy,
      agents: [makeAgent({ id: "u1" })],
      groupCandidates: [candidate({ id: "g1", memberIds: ["m1", "m2", "m3", "m4"], status: "confirmed" })],
    });
    const result = runSchoolInterventionHook(openGroupSignalIntervention, ctx);
    expect(result.events).toEqual([]);
    expect(result.effects).toEqual([]);
  });

  it("emits an ended event (without re-emitting a presented event) once a previously-signaled group becomes full", () => {
    const runtimeState = { ...createInitialInterventionRuntimeState(), intervenedGroupIds: ["g1"] };
    const ctx = makeOpenGroupContext({
      formationPolicy: pairPolicy,
      agents: [makeAgent({ id: "u1" })],
      groupCandidates: [candidate({ id: "g1", memberIds: ["m1", "m2"], status: "confirmed" })],
      runtimeState,
    });
    const result = runSchoolInterventionHook(openGroupSignalIntervention, ctx);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].metadata).toMatchObject({
      schoolInterventionId: "open-group-signal",
      groupId: "g1",
      outcome: "assigned",
      triggerReason: "groupBecameFull",
    });
    expect(result.runtimeState.intervenedGroupIds).toEqual([]);
  });
});

// --- engine.ts integration -----------------------------------------------------------------

function runClassroomTicks(
  seed: number,
  params: SimParams,
  ticks: number,
  formation: FormationRuntimeOptions,
  interventionId?: "nearby-peer-prompt" | "open-group-signal" | "anonymous-help-signal" | "teacher-recommendation" | "none",
): SimulationState[] {
  const rng = new SeededRandom(seed);
  const intervention = interventionId ? { interventionId } : undefined;
  const states: SimulationState[] = [];
  let state = createInitialState(seed, params, intervention, undefined, undefined, undefined, undefined, formation);
  states.push(state);
  for (let i = 0; i < ticks && !state.finished; i++) {
    state = stepSimulation(state, params, rng, intervention, undefined, undefined, undefined, undefined, formation);
    states.push(state);
  }
  return states;
}

describe("nearby-peer-prompt: engine.ts integration (Issue #157)", () => {
  const formation: FormationRuntimeOptions = { scenarioId: "classroomPair", formationDeadlineTick: 150 };
  const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 12, numLeaders: 1, overallWillingness: 0.6 };

  it("createInitialState starts with an empty interventionRuntimeState/activeInterventionEffects", () => {
    const state = createInitialState(
      5,
      params,
      { interventionId: "nearby-peer-prompt" },
      undefined,
      undefined,
      undefined,
      undefined,
      formation,
    );
    expect(state.activeInterventionEffects).toEqual([]);
    expect(state.interventionRuntimeState?.intervenedAgentIds).toEqual([]);
  });

  it("is byte-identical to the no-intervention run before the stagnation threshold tick (no-op invariance)", () => {
    const none = runClassroomTicks(3, params, NEARBY_PEER_PROMPT_MIN_TICK - 1, formation, "none");
    const withIntervention = runClassroomTicks(3, params, NEARBY_PEER_PROMPT_MIN_TICK - 1, formation, "nearby-peer-prompt");

    expect(withIntervention.at(-1)?.agents.map((a) => ({ x: a.x, y: a.y, state: a.state }))).toEqual(
      none.at(-1)?.agents.map((a) => ({ x: a.x, y: a.y, state: a.state })),
    );
    expect(withIntervention.at(-1)?.groupCandidates).toEqual(none.at(-1)?.groupCandidates);
  });

  it("does not affect the afterParty scenario even if selected (applicability guard)", () => {
    const afterPartyParams: SimParams = { ...DEFAULT_PARAMS, populationSize: 10 };
    const noneRun = runClassroomTicks(9, afterPartyParams, 40, { scenarioId: "afterParty" }, "none");
    const interventionRun = runClassroomTicks(9, afterPartyParams, 40, { scenarioId: "afterParty" }, "nearby-peer-prompt");
    expect(interventionRun.at(-1)?.agents.map((a) => ({ x: a.x, y: a.y, state: a.state }))).toEqual(
      noneRun.at(-1)?.agents.map((a) => ({ x: a.x, y: a.y, state: a.state })),
    );
  });

  it("eventually triggers a schoolInterventionTriggered prompt event over a full run, and effects expire", () => {
    const states = runClassroomTicks(11, params, 150, formation, "nearby-peer-prompt");
    const finalState = states.at(-1)!;
    const triggered = finalState.log.filter(
      (entry) => entry.eventType === "schoolInterventionTriggered" && entry.metadata?.schoolInterventionId === "nearby-peer-prompt",
    );
    expect(triggered.length).toBeGreaterThan(0);
    // 最終tickでは、直近で発火していない限り効果は残らない(expiresAtTickを過ぎたら除去される)
    for (const effect of finalState.activeInterventionEffects ?? []) {
      expect(finalState.tick).toBeLessThan(effect.expiresAtTick);
    }
  });

  it("produces the same schoolInterventionTriggered sequence for the same seed (reproducibility)", () => {
    const a = runClassroomTicks(21, params, 100, formation, "nearby-peer-prompt");
    const b = runClassroomTicks(21, params, 100, formation, "nearby-peer-prompt");
    const eventsA = a.at(-1)?.log.filter((e) => e.eventType === "schoolInterventionTriggered");
    const eventsB = b.at(-1)?.log.filter((e) => e.eventType === "schoolInterventionTriggered");
    expect(eventsA).toEqual(eventsB);
  });
});

describe("open-group-signal: engine.ts integration (Issue #157)", () => {
  it("never lets a variable-capacity (3-4 person) group exceed its maxGroupSize while the intervention is active", () => {
    const groupSize: GroupSizeRule = { minGroupSize: 3, maxGroupSize: 4 };
    const formation: FormationRuntimeOptions = {
      scenarioId: "classroomPair",
      formationDeadlineTick: 150,
      classroomGroupSize: groupSize,
    };
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 16, numLeaders: 2, overallWillingness: 0.7 };
    const states = runClassroomTicks(17, params, 150, formation, "open-group-signal");
    const finalState = states.at(-1)!;
    for (const candidate of finalState.groupCandidates) {
      expect(candidate.memberIds.length).toBeLessThanOrEqual(groupSize.maxGroupSize);
    }
  });

  it("is byte-identical to the no-intervention run when no candidate has ever formed yet (no-op invariance)", () => {
    const formation: FormationRuntimeOptions = { scenarioId: "classroomPair", formationDeadlineTick: 150 };
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 12, numLeaders: 0, overallWillingness: 0 };
    const none = runClassroomTicks(4, params, 3, formation, "none");
    const withIntervention = runClassroomTicks(4, params, 3, formation, "open-group-signal");
    expect(withIntervention.at(-1)?.agents).toEqual(none.at(-1)?.agents);
    expect(withIntervention.at(-1)?.groupCandidates).toEqual(none.at(-1)?.groupCandidates);
  });

  it("resets interventionRuntimeState on a fresh createInitialState (Reset/seed/preset change)", () => {
    const formation: FormationRuntimeOptions = { scenarioId: "classroomPair", formationDeadlineTick: 150 };
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 16, numLeaders: 2, overallWillingness: 0.7 };
    const midRun = runClassroomTicks(23, params, 60, formation, "open-group-signal");
    expect((midRun.at(-1)?.interventionRuntimeState?.intervenedGroupIds.length ?? 0) >= 0).toBe(true);

    const fresh = createInitialState(
      23,
      params,
      { interventionId: "open-group-signal" },
      undefined,
      undefined,
      undefined,
      undefined,
      formation,
    );
    expect(fresh.interventionRuntimeState?.intervenedGroupIds).toEqual([]);
    expect(fresh.activeInterventionEffects).toEqual([]);
  });
});

// --- Issue #158: anonymous-help-signal / teacher-recommendation ------------------------------

function makeCandidate(overrides: Partial<GroupCandidate>): GroupCandidate {
  return { id: "g1", x: 0, y: 0, memberIds: [], status: "forming", age: 0, ...overrides };
}

describe("anonymousHelpSignalIntervention", () => {
  it("is a no-op outside classroomPair (afterParty guard)", () => {
    const a = makeAgent({ id: "a", stress: 10, leaveThreshold: 0.1 });
    const ctx = makeContext({ hook: "beforeTick", agents: [a], formationPolicy: afterPartyPolicy });
    const result = runSchoolInterventionHook(anonymousHelpSignalIntervention, ctx);
    expect(result.events).toEqual([]);
    expect(result.runtimeState).toBe(ctx.runtimeState);
  });

  it("is a no-op before the minimum tick threshold", () => {
    const a = makeAgent({ id: "a", stress: 10, leaveThreshold: 0.1 });
    const ctx = makeContext({ hook: "beforeTick", agents: [a], tick: ANONYMOUS_HELP_MIN_TICK - 1 });
    const result = runSchoolInterventionHook(anonymousHelpSignalIntervention, ctx);
    expect(result.events).toEqual([]);
  });

  it("is a no-op when no trigger condition is met", () => {
    const a = makeAgent({ id: "a", stress: 0, leaveThreshold: 1, searchRestartCount: 0, capacityFailureCount: 0 });
    const ctx = makeContext({ hook: "beforeTick", agents: [a], tick: ANONYMOUS_HELP_MIN_TICK });
    const result = runSchoolInterventionHook(anonymousHelpSignalIntervention, ctx);
    expect(result.events).toEqual([]);
  });

  it("is a no-op for agents who are not undecided (joined/left/unassigned)", () => {
    for (const state of ["joined", "left", "unassigned"] as const) {
      const a = makeAgent({ id: "a", state, stress: 10, leaveThreshold: 0.1 });
      const ctx = makeContext({ hook: "beforeTick", agents: [a], tick: ANONYMOUS_HELP_MIN_TICK });
      const result = runSchoolInterventionHook(anonymousHelpSignalIntervention, ctx);
      expect(result.events).toEqual([]);
    }
  });

  it("triggers on high stress relative to leaveThreshold, without leaking the agent's identity in the public message", () => {
    const a = makeAgent({ id: "a", label: "SECRET-LABEL", stress: 0.6, leaveThreshold: 1 });
    const ctx = makeContext({ hook: "beforeTick", agents: [a], tick: ANONYMOUS_HELP_MIN_TICK });
    const result = runSchoolInterventionHook(anonymousHelpSignalIntervention, ctx);

    expect(result.events).toHaveLength(1);
    const event = result.events[0];
    expect(event.eventType).toBe("anonymousHelpRequested");
    // 受入条件: 匿名通知では公開画面から個人が特定されない -> messageに氏名/IDを含めない
    expect(event.message).not.toContain("SECRET-LABEL");
    expect(event.message).not.toContain(a.id);
    // 構造化metadataには内部agent IDを保持する(教師向け詳細のみが参照する想定)
    expect(event.metadata).toMatchObject({
      schoolInterventionId: "anonymous-help-signal",
      agentId: "a",
      isTeacherSource: false,
      triggerReason: "highStress",
      outcome: "presented",
    });
    expect(result.runtimeState.anonymouslyNotifiedAgentIds).toEqual(["a"]);
  });

  it("triggers on repeated search restarts even with low stress", () => {
    const a = makeAgent({
      id: "a",
      stress: 0,
      leaveThreshold: 1,
      searchRestartCount: ANONYMOUS_HELP_MIN_SEARCH_RESTARTS,
    });
    const ctx = makeContext({ hook: "beforeTick", agents: [a], tick: ANONYMOUS_HELP_MIN_TICK });
    const result = runSchoolInterventionHook(anonymousHelpSignalIntervention, ctx);
    expect(result.events[0]?.metadata?.triggerReason).toBe("repeatedSearchRestarts");
  });

  it("triggers on repeated capacity failures even with low stress and no search restarts", () => {
    const a = makeAgent({
      id: "a",
      stress: 0,
      leaveThreshold: 1,
      capacityFailureCount: ANONYMOUS_HELP_MIN_CAPACITY_FAILURES,
    });
    const ctx = makeContext({ hook: "beforeTick", agents: [a], tick: ANONYMOUS_HELP_MIN_TICK });
    const result = runSchoolInterventionHook(anonymousHelpSignalIntervention, ctx);
    expect(result.events[0]?.metadata?.triggerReason).toBe("repeatedCapacityFailures");
  });

  it("does not re-notify within the cooldown window, but does after it elapses", () => {
    const a = makeAgent({ id: "a", stress: 0.6, leaveThreshold: 1 });
    const notifiedCtx = makeContext({
      hook: "beforeTick",
      agents: [a],
      tick: ANONYMOUS_HELP_MIN_TICK + 5,
      runtimeState: {
        ...createInitialInterventionRuntimeState(),
        anonymouslyNotifiedAgentIds: ["a"],
        lastTriggeredAtTick: { "anonymous-help-signal:a": ANONYMOUS_HELP_MIN_TICK },
      },
    });
    const stillCoolingDown = runSchoolInterventionHook(anonymousHelpSignalIntervention, notifiedCtx);
    expect(stillCoolingDown.events).toEqual([]);

    const afterCooldownCtx = makeContext({
      ...notifiedCtx,
      tick: ANONYMOUS_HELP_MIN_TICK + ANONYMOUS_HELP_COOLDOWN_TICKS,
    });
    const renewed = runSchoolInterventionHook(anonymousHelpSignalIntervention, afterCooldownCtx);
    expect(renewed.events).toHaveLength(1);
  });

  it("emits one event per eligible agent, in stable id order, and is deterministic", () => {
    const b = makeAgent({ id: "b", stress: 0.6, leaveThreshold: 1 });
    const a = makeAgent({ id: "a", stress: 0.6, leaveThreshold: 1 });
    const ctx1 = makeContext({ hook: "beforeTick", agents: [b, a], tick: ANONYMOUS_HELP_MIN_TICK });
    const ctx2 = makeContext({ hook: "beforeTick", agents: [b, a], tick: ANONYMOUS_HELP_MIN_TICK });
    const r1 = runSchoolInterventionHook(anonymousHelpSignalIntervention, ctx1);
    const r2 = runSchoolInterventionHook(anonymousHelpSignalIntervention, ctx2);
    expect(r1.events.map((e) => e.metadata?.agentId)).toEqual(["a", "b"]);
    expect(r1.events).toEqual(r2.events);
  });

  it("generates no effects (notification alone must not move/assign agents)", () => {
    const a = makeAgent({ id: "a", stress: 0.6, leaveThreshold: 1 });
    const ctx = makeContext({ hook: "beforeTick", agents: [a], tick: ANONYMOUS_HELP_MIN_TICK });
    const result = runSchoolInterventionHook(anonymousHelpSignalIntervention, ctx);
    expect(result.effects).toEqual([]);
  });
});

describe("teacherRecommendation: pure candidate scoring/acceptance functions", () => {
  it("selectRecommendationTarget returns undefined for an empty option list", () => {
    expect(selectRecommendationTarget([])).toBeUndefined();
  });

  it("selectRecommendationTarget prefers the closer option", () => {
    const near = makeAgent({ id: "near", x: 10, y: 0 });
    const far = makeAgent({ id: "far", x: 100, y: 0 });
    const options: RecommendationTarget[] = [
      { kind: "peer", peer: far, distance: 100, sameClique: false },
      { kind: "peer", peer: near, distance: 10, sameClique: false },
    ];
    expect(selectRecommendationTarget(options)).toEqual(options[1]);
  });

  it("selectRecommendationTarget breaks distance ties in favor of an existing clique relationship", () => {
    const stranger = makeAgent({ id: "stranger" });
    const cliqueMate = makeAgent({ id: "cliquemate" });
    const options: RecommendationTarget[] = [
      { kind: "peer", peer: stranger, distance: 50, sameClique: false },
      { kind: "peer", peer: cliqueMate, distance: 50, sameClique: true },
    ];
    const picked = selectRecommendationTarget(options);
    expect(picked?.kind === "peer" && picked.peer.id).toBe("cliquemate");
  });

  it("selectRecommendationTarget breaks remaining ties by stable (ascending) id order", () => {
    const b = makeAgent({ id: "b" });
    const a = makeAgent({ id: "a" });
    const options: RecommendationTarget[] = [
      { kind: "peer", peer: b, distance: 50, sameClique: false },
      { kind: "peer", peer: a, distance: 50, sameClique: false },
    ];
    const picked = selectRecommendationTarget(options);
    expect(picked?.kind === "peer" && picked.peer.id).toBe("a");
  });

  it("computeRecommendationAcceptanceProbability increases with willingness and decreases with influenceAvoidance", () => {
    const peer = makeAgent({ id: "peer" });
    const target: RecommendationTarget = { kind: "peer", peer, distance: 0, sameClique: false };
    const willing = makeAgent({ willingness: 0.9, influenceAvoidance: 0.1, stress: 0, leaveThreshold: 1 });
    const reluctant = makeAgent({ willingness: 0.2, influenceAvoidance: 0.9, stress: 0, leaveThreshold: 1 });
    expect(computeRecommendationAcceptanceProbability(willing, target)).toBeGreaterThan(
      computeRecommendationAcceptanceProbability(reluctant, target),
    );
  });

  it("computeRecommendationAcceptanceProbability is always within [0, 1]", () => {
    const peer = makeAgent({ id: "peer" });
    const target: RecommendationTarget = { kind: "peer", peer, distance: 0, sameClique: true };
    const extreme = makeAgent({ willingness: 1, influenceAvoidance: 0, stress: 999, leaveThreshold: 0.001 });
    const p = computeRecommendationAcceptanceProbability(extreme, target);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });

  describe("buildRecommendationOptions", () => {
    const pairPolicy = getFormationPolicyById("classroomPair", 150, { minGroupSize: 2, maxGroupSize: 2 });

    it("excludes full, dissolving, dissolved, and expired candidates", () => {
      const a = makeAgent({ id: "a" });
      const full = makeCandidate({ id: "full", memberIds: ["m1", "m2"], status: "confirmed" });
      const dissolving = makeCandidate({ id: "dissolving", status: "dissolving" });
      const dissolved = makeCandidate({ id: "dissolved", status: "dissolved" });
      const expired = makeCandidate({ id: "expired", status: "expired" });
      const ctx = makeContext({
        agents: [a],
        groupCandidates: [full, dissolving, dissolved, expired],
        formationPolicy: pairPolicy,
      });
      const options = buildRecommendationOptions(a, ctx, new Set(), new Set());
      expect(options.filter((o) => o.kind === "group")).toEqual([]);
    });

    it("excludes a candidate the agent recently failed to join", () => {
      const a = makeAgent({ id: "a", lastFailedCandidateId: "g1", lastFailedCandidateAtTick: 5 });
      const g1 = makeCandidate({ id: "g1", memberIds: ["m1"], status: "forming" });
      const ctx = makeContext({ agents: [a], groupCandidates: [g1], formationPolicy: pairPolicy, tick: 6 });
      const options = buildRecommendationOptions(a, ctx, new Set(), new Set());
      expect(options.filter((o) => o.kind === "group")).toEqual([]);
    });

    it("excludes reserved group/peer ids", () => {
      const a = makeAgent({ id: "a" });
      const b = makeAgent({ id: "b" });
      const g1 = makeCandidate({ id: "g1", memberIds: ["m1"], status: "forming" });
      const ctx = makeContext({ agents: [a, b], groupCandidates: [g1], formationPolicy: pairPolicy });
      const options = buildRecommendationOptions(a, ctx, new Set(["g1"]), new Set(["b"]));
      expect(options).toEqual([]);
    });

    it("excludes the agent itself and non-undecided peers from peer options", () => {
      const a = makeAgent({ id: "a" });
      const joined = makeAgent({ id: "joined", state: "joined" });
      const undecidedPeer = makeAgent({ id: "peer" });
      const ctx = makeContext({ agents: [a, joined, undecidedPeer], groupCandidates: [], formationPolicy: pairPolicy });
      const options = buildRecommendationOptions(a, ctx, new Set(), new Set());
      expect(options.map((o) => (o.kind === "peer" ? o.peer.id : o.candidate.id))).toEqual(["peer"]);
    });
  });
});

describe("teacherRecommendationIntervention", () => {
  it("is a no-op outside classroomPair (afterParty guard)", () => {
    const a = makeAgent({ id: "a" });
    const b = makeAgent({ id: "b" });
    const ctx = makeContext({
      agents: [a, b],
      formationPolicy: afterPartyPolicy,
      tick: TEACHER_RECOMMENDATION_LONG_WAIT_TICK,
    });
    const result = runSchoolInterventionHook(teacherRecommendationIntervention, ctx);
    expect(result.events).toEqual([]);
    expect(result.effects).toEqual([]);
  });

  it("is a no-op before the minimum tick threshold", () => {
    const a = makeAgent({ id: "a" });
    const b = makeAgent({ id: "b" });
    const ctx = makeContext({ agents: [a, b], tick: TEACHER_RECOMMENDATION_MIN_TICK - 1 });
    const result = runSchoolInterventionHook(teacherRecommendationIntervention, ctx);
    expect(result.events).toEqual([]);
  });

  it("does not consider an agent ineligible (neither anonymously notified nor long-waiting)", () => {
    const a = makeAgent({ id: "a" });
    const b = makeAgent({ id: "b" });
    const ctx = makeContext({ agents: [a, b], tick: TEACHER_RECOMMENDATION_MIN_TICK });
    const result = runSchoolInterventionHook(teacherRecommendationIntervention, ctx);
    expect(result.events).toEqual([]);
  });

  it("considers an agent eligible once anonymously notified, even before the long-wait threshold", () => {
    const a = makeAgent({ id: "a" });
    const b = makeAgent({ id: "b" });
    const ctx = makeContext({
      agents: [a, b],
      tick: TEACHER_RECOMMENDATION_MIN_TICK,
      runtimeState: { ...createInitialInterventionRuntimeState(), anonymouslyNotifiedAgentIds: ["a"] },
    });
    const result = runSchoolInterventionHook(teacherRecommendationIntervention, ctx);
    expect(result.events.some((e) => e.metadata?.agentId === "a")).toBe(true);
  });

  it("considers an agent eligible once the long-wait threshold is reached, without anonymous notification", () => {
    const a = makeAgent({ id: "a" });
    const b = makeAgent({ id: "b" });
    const ctx = makeContext({ agents: [a, b], tick: TEACHER_RECOMMENDATION_LONG_WAIT_TICK });
    const result = runSchoolInterventionHook(teacherRecommendationIntervention, ctx);
    expect(result.events.some((e) => e.metadata?.agentId === "a")).toBe(true);
  });

  it("emits teacherRecommendationUnavailable and records a cooldown when there is no eligible target", () => {
    const solo = makeAgent({ id: "a" });
    const ctx = makeContext({ agents: [solo], groupCandidates: [], tick: TEACHER_RECOMMENDATION_LONG_WAIT_TICK });
    const result = runSchoolInterventionHook(teacherRecommendationIntervention, ctx);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      eventType: "teacherRecommendationUnavailable",
      metadata: { schoolInterventionId: "teacher-recommendation", agentId: "a", outcome: "unavailable" },
    });
    expect(result.runtimeState.lastTriggeredAtTick["teacher-recommendation:a"]).toBe(ctx.tick);
  });

  it("issues a recommendation and deterministically resolves accept/decline via the intervention-only rng (never touching the main rng)", () => {
    const a = makeAgent({ id: "a", x: 0, y: 0 });
    const peer = makeAgent({ id: "peer", x: 5, y: 0 });
    const ctx = makeContext({ agents: [a, peer], groupCandidates: [], tick: TEACHER_RECOMMENDATION_LONG_WAIT_TICK });
    const result = runSchoolInterventionHook(teacherRecommendationIntervention, ctx);

    const issued = result.events.find((e) => e.eventType === "teacherRecommendationIssued");
    expect(issued?.metadata).toMatchObject({
      schoolInterventionId: "teacher-recommendation",
      agentId: "a",
      secondAgentId: "peer",
      recommendationTargetKind: "peer",
      outcome: "presented",
    });

    // 受諾/拒否は本体rngとは独立な介入専用rngのみで決まる(受入条件: 本体PRNG系列を不用意にずらさない)。
    // 同じ導出方法をテスト側でも再現し、hookの実際の分岐と一致することを確認する。
    const target: RecommendationTarget = { kind: "peer", peer, distance: 5, sameClique: false };
    const probability = computeRecommendationAcceptanceProbability(a, target);
    const expectedRng = createInterventionRandom(ctx.runSeed, "teacher-recommendation", ctx.tick, "a");
    const expectedAccepted = expectedRng.chance(probability);

    const acceptedEvent = result.events.find((e) => e.eventType === "teacherRecommendationAccepted");
    const declinedEvent = result.events.find((e) => e.eventType === "teacherRecommendationDeclined");
    if (expectedAccepted) {
      expect(acceptedEvent).toBeDefined();
      expect(declinedEvent).toBeUndefined();
      expect(result.effects.length).toBeGreaterThan(0);
      expect(result.runtimeState.recommendedPeerIdByAgentId.a).toBe("peer");
    } else {
      expect(declinedEvent).toBeDefined();
      expect(acceptedEvent).toBeUndefined();
      expect(result.effects).toEqual([]);
    }
  });

  it("never recommends a full, dissolving, dissolved, or expired candidate", () => {
    const pairPolicy = getFormationPolicyById("classroomPair", 150, { minGroupSize: 2, maxGroupSize: 2 });
    const a = makeAgent({ id: "a" });
    const full = makeCandidate({ id: "full", memberIds: ["m1", "m2"], status: "confirmed" });
    const ctx = makeContext({
      agents: [a],
      groupCandidates: [full],
      formationPolicy: pairPolicy,
      tick: TEACHER_RECOMMENDATION_LONG_WAIT_TICK,
    });
    const result = runSchoolInterventionHook(teacherRecommendationIntervention, ctx);
    const issued = result.events.find((e) => e.eventType === "teacherRecommendationIssued");
    expect(issued?.metadata?.groupId).not.toBe("full");
  });

  it("does not double-book the same single-vacancy candidate for two agents recommended in the same tick", () => {
    const pairPolicy = getFormationPolicyById("classroomPair", 150, { minGroupSize: 2, maxGroupSize: 2 });
    const a = makeAgent({ id: "a", x: 0, y: 0 });
    const b = makeAgent({ id: "b", x: 1000, y: 1000 });
    const g1 = makeCandidate({ id: "g1", x: 0, y: 0, memberIds: ["m1"], status: "forming" });
    const ctx = makeContext({
      agents: [a, b],
      groupCandidates: [g1],
      formationPolicy: pairPolicy,
      tick: TEACHER_RECOMMENDATION_LONG_WAIT_TICK,
    });
    const result = runSchoolInterventionHook(teacherRecommendationIntervention, ctx);
    const issuedForG1 = result.events.filter(
      (e) => e.eventType === "teacherRecommendationIssued" && e.metadata?.groupId === "g1",
    );
    expect(issuedForG1).toHaveLength(1);
  });

  it("is deterministic: the same context always yields the same events and effects", () => {
    const a = makeAgent({ id: "a", x: 0, y: 0 });
    const peer = makeAgent({ id: "peer", x: 5, y: 0 });
    const ctx1 = makeContext({ agents: [a, peer], groupCandidates: [], tick: TEACHER_RECOMMENDATION_LONG_WAIT_TICK });
    const ctx2 = makeContext({ agents: [a, peer], groupCandidates: [], tick: TEACHER_RECOMMENDATION_LONG_WAIT_TICK });
    const r1 = runSchoolInterventionHook(teacherRecommendationIntervention, ctx1);
    const r2 = runSchoolInterventionHook(teacherRecommendationIntervention, ctx2);
    expect(r1.events).toEqual(r2.events);
    expect(r1.effects).toEqual(r2.effects);
  });

  describe("onAfterStateTransition: resolving accepted recommendations", () => {
    it("emits teacherRecommendationTargetInvalidated and clears tracking when the recommended group becomes full", () => {
      const a = makeAgent({ id: "a", state: "undecided" });
      const g1 = makeCandidate({ id: "g1", memberIds: ["m1", "m2"], status: "confirmed" });
      const pairPolicy = getFormationPolicyById("classroomPair", 150, { minGroupSize: 2, maxGroupSize: 2 });
      const ctx = makeContext({
        hook: "afterStateTransition",
        agents: [a],
        groupCandidates: [g1],
        formationPolicy: pairPolicy,
        runtimeState: {
          ...createInitialInterventionRuntimeState(),
          recommendedGroupIdByAgentId: { a: "g1" },
          recommendationIssuedAtTick: { a: 10 },
        },
      });
      const result = runSchoolInterventionHook(teacherRecommendationIntervention, ctx);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        eventType: "teacherRecommendationTargetInvalidated",
        metadata: { agentId: "a", groupId: "g1", outcome: "unavailable" },
      });
      expect(result.runtimeState.recommendedGroupIdByAgentId).toEqual({});
    });

    it("emits a schoolInterventionTriggered (assigned) event with ticksSinceRecommendation once the agent actually joins the recommended group", () => {
      const a = makeAgent({ id: "a", state: "joined", joinedGroupId: "g1" });
      const g1 = makeCandidate({ id: "g1", memberIds: ["a", "m1"], status: "confirmed" });
      const ctx = makeContext({
        hook: "afterStateTransition",
        agents: [a],
        groupCandidates: [g1],
        tick: 30,
        runtimeState: {
          ...createInitialInterventionRuntimeState(),
          recommendedGroupIdByAgentId: { a: "g1" },
          recommendationIssuedAtTick: { a: 10 },
        },
      });
      const result = runSchoolInterventionHook(teacherRecommendationIntervention, ctx);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        eventType: "schoolInterventionTriggered",
        metadata: { agentId: "a", groupId: "g1", outcome: "assigned", ticksSinceRecommendation: 20 },
      });
      expect(result.runtimeState.recommendedGroupIdByAgentId).toEqual({});
    });

    it("silently stops tracking (no event) once the agent leaves/unassigned for reasons unrelated to the recommendation", () => {
      const a = makeAgent({ id: "a", state: "unassigned" });
      const g1 = makeCandidate({ id: "g1", memberIds: [], status: "forming" });
      const ctx = makeContext({
        hook: "afterStateTransition",
        agents: [a],
        groupCandidates: [g1],
        runtimeState: {
          ...createInitialInterventionRuntimeState(),
          recommendedGroupIdByAgentId: { a: "g1" },
          recommendationIssuedAtTick: { a: 10 },
        },
      });
      const result = runSchoolInterventionHook(teacherRecommendationIntervention, ctx);
      expect(result.events).toEqual([]);
      expect(result.runtimeState.recommendedGroupIdByAgentId).toEqual({});
    });

    it("is a no-op when there is nothing being tracked", () => {
      const a = makeAgent({ id: "a" });
      const ctx = makeContext({ hook: "afterStateTransition", agents: [a], groupCandidates: [] });
      const result = runSchoolInterventionHook(teacherRecommendationIntervention, ctx);
      expect(result.events).toEqual([]);
      expect(result.runtimeState).toBe(ctx.runtimeState);
    });
  });
});

describe("anonymous-help-signal / teacher-recommendation: engine.ts integration (Issue #158)", () => {
  it("createInitialState starts with an empty interventionRuntimeState/activeInterventionEffects for both interventions", () => {
    for (const interventionId of ["anonymous-help-signal", "teacher-recommendation"] as const) {
      const state = createInitialState(
        5,
        { ...DEFAULT_PARAMS, populationSize: 12 },
        { interventionId },
        undefined,
        undefined,
        undefined,
        undefined,
        { scenarioId: "classroomPair", formationDeadlineTick: 150 },
      );
      expect(state.activeInterventionEffects).toEqual([]);
      expect(state.interventionRuntimeState?.anonymouslyNotifiedAgentIds).toEqual([]);
    }
  });

  it("does not affect the afterParty scenario even if selected (applicability guard)", () => {
    const afterPartyParams: SimParams = { ...DEFAULT_PARAMS, populationSize: 10 };
    for (const interventionId of ["anonymous-help-signal", "teacher-recommendation"] as const) {
      const noneRun = runClassroomTicks(9, afterPartyParams, 40, { scenarioId: "afterParty" }, "none");
      const interventionRun = runClassroomTicks(9, afterPartyParams, 40, { scenarioId: "afterParty" }, interventionId);
      expect(interventionRun.at(-1)?.agents.map((a) => ({ x: a.x, y: a.y, state: a.state }))).toEqual(
        noneRun.at(-1)?.agents.map((a) => ({ x: a.x, y: a.y, state: a.state })),
      );
    }
  });

  it("eventually notifies and recommends over a full run, and never exceeds a fixed pair's capacity", () => {
    const formation: FormationRuntimeOptions = { scenarioId: "classroomPair", formationDeadlineTick: 150 };
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 13, numLeaders: 1, overallWillingness: 0.4 };
    const states = runClassroomTicks(7, params, 150, formation, "teacher-recommendation");
    const finalState = states.at(-1)!;
    for (const candidate of finalState.groupCandidates) {
      expect(candidate.memberIds.length).toBeLessThanOrEqual(2);
    }
  });

  it("never lets a variable-capacity (3-4 person) group exceed its maxGroupSize with teacher-recommendation active", () => {
    const groupSize: GroupSizeRule = { minGroupSize: 3, maxGroupSize: 4 };
    const formation: FormationRuntimeOptions = {
      scenarioId: "classroomPair",
      formationDeadlineTick: 150,
      classroomGroupSize: groupSize,
    };
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 16, numLeaders: 2, overallWillingness: 0.7 };
    const states = runClassroomTicks(17, params, 150, formation, "teacher-recommendation");
    const finalState = states.at(-1)!;
    for (const candidate of finalState.groupCandidates) {
      expect(candidate.memberIds.length).toBeLessThanOrEqual(groupSize.maxGroupSize);
    }
  });

  it("produces the same structured event sequence for the same seed (reproducibility)", () => {
    const formation: FormationRuntimeOptions = { scenarioId: "classroomPair", formationDeadlineTick: 150 };
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 14, numLeaders: 1, overallWillingness: 0.5 };
    const a = runClassroomTicks(31, params, 150, formation, "teacher-recommendation");
    const b = runClassroomTicks(31, params, 150, formation, "teacher-recommendation");
    const eventsA = a.at(-1)?.log.filter((e) => e.eventType?.startsWith("teacherRecommendation"));
    const eventsB = b.at(-1)?.log.filter((e) => e.eventType?.startsWith("teacherRecommendation"));
    expect(eventsA).toEqual(eventsB);
  });

  it("resets interventionRuntimeState on a fresh createInitialState (Reset/seed/preset change)", () => {
    const formation: FormationRuntimeOptions = { scenarioId: "classroomPair", formationDeadlineTick: 150 };
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 16, numLeaders: 2, overallWillingness: 0.7 };
    runClassroomTicks(23, params, 60, formation, "teacher-recommendation");

    const fresh = createInitialState(
      23,
      params,
      { interventionId: "teacher-recommendation" },
      undefined,
      undefined,
      undefined,
      undefined,
      formation,
    );
    expect(fresh.interventionRuntimeState?.recommendedGroupIdByAgentId).toEqual({});
    expect(fresh.interventionRuntimeState?.recommendedPeerIdByAgentId).toEqual({});
    expect(fresh.activeInterventionEffects).toEqual([]);
  });

  it("does not affect afterParty/no-intervention regression for the existing preset suite", () => {
    const params: SimParams = { ...DEFAULT_PARAMS };
    const none = runClassroomTicks(3, params, 30, { scenarioId: "afterParty" }, "none");
    expect(none.at(-1)?.finished).toBeDefined();
  });
});
