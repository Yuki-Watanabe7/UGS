/**
 * Issue #267 (standingParty Phase 7 統合検証, roadmap #172): #262〜#265 が実装した
 * 飲食台・欲求・目的移動・受け取り・再回遊・台付近の機会を、決定的fixture・複数seedの
 * 長時間実行・Phase 6/Phase 5 との互換で横断確認する。
 *
 * 個々の数式は `venueVisitLifecycle.test.ts` / `venueEncounter.test.ts` /
 * `venueVisitEngineWiring.test.ts` に委ねる。このファイルは「喉の渇きで輪を離れ、
 * ドリンクを受け取って別の輪へ戻る」「台の近さだけでは接触にならない」「無効時は
 * Phase 6 の座標・所属・event・情報伝播・PRNGが保たれる」という境界を固定する。
 *
 * 係数は仮説的な内部値であり、現実の食欲や人流の妥当性を主張しない。ON/OFFの件数差は
 * 説明用の記録であり、統計的有意差の検定はしない。
 */
import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { getFormationPolicyById, type FormationRuntimeOptions } from "./formationPolicy";
import { distance } from "./model";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS, getPresetById } from "./presets";
import { DEFAULT_CLUSTER_DEPARTURE_DECISION_CONFIG } from "./clusterDepartureDecision";
import { DEFAULT_SPATIAL_DYNAMICS_CONFIG } from "./spatialDynamics";
import {
  buildStandingPartyContactNetwork,
  buildStandingPartyConversationHistory,
  createContactIntervalId,
} from "./standingPartyAnalysis";
import { assertStandingPartyInvariants, assertStandingPartySpatialInvariants } from "./standingPartyInvariants";
import {
  DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
  INFO_RICH_STANDING_PARTY_CONFIG,
  SPATIAL_ROAMING_STANDING_PARTY_CONFIG,
  type StandingPartyScenarioConfig,
} from "./standingPartyScenarioConfig";
import type { Agent, GroupCandidate, SimParams, SimulationState } from "./types";
import {
  DEFAULT_VENUE_ANCHOR_CONFIG,
  MVP_DRINK_ANCHOR,
  MVP_FOOD_ANCHOR,
  MVP_VENUE_ANCHORS,
  type PendingVenueVisit,
  type VenueAnchor,
  type VenueAnchorConfig,
} from "./venueAnchors";

function venueConfig(overrides: Partial<VenueAnchorConfig> = {}): VenueAnchorConfig {
  return {
    ...DEFAULT_VENUE_ANCHOR_CONFIG,
    enabled: true,
    anchors: overrides.anchors ? overrides.anchors.map((anchor) => ({ ...anchor })) : MVP_VENUE_ANCHORS.map((anchor) => ({ ...anchor })),
    ...overrides,
    needs: { ...DEFAULT_VENUE_ANCHOR_CONFIG.needs, ...overrides.needs },
    visit: { ...DEFAULT_VENUE_ANCHOR_CONFIG.visit, ...overrides.visit },
    encounter: { ...DEFAULT_VENUE_ANCHOR_CONFIG.encounter, ...overrides.encounter },
  };
}

/** 決定的fixture用。自発離脱の寄与を0にし、飲食離脱だけが輪を空けるようにする。 */
function quietStanding(config: VenueAnchorConfig): FormationRuntimeOptions {
  return {
    scenarioId: "standingParty",
    standingPartyConfig: {
      ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
      clusterDeparture: {
        ...DEFAULT_CLUSTER_DEPARTURE_DECISION_CONFIG,
        maxDissatisfactionContribution: 0,
        maxCirculationContribution: 0,
      },
      spatialDynamics: { ...DEFAULT_SPATIAL_DYNAMICS_CONFIG, enabled: false },
      venueAnchors: config,
    },
  };
}

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-a",
    label: "A",
    x: 400,
    y: 260,
    vx: 0,
    vy: 0,
    willingness: 0.95,
    initiative: 0.1,
    ambiguityTolerance: 0.8,
    influenceAvoidance: 0.05,
    conformity: 0.95,
    leaveThreshold: 0.95,
    isObserverJoiner: false,
    state: "undecided",
    stress: 0.05,
    socialCirculationTendency: 0,
    ...overrides,
  };
}

function episode(agentId: string, clusterId: string, members: number): NonNullable<Agent["currentEpisode"]> {
  return {
    episodeId: `${agentId}:${clusterId}:0`,
    clusterId,
    joinedAtTick: 0,
    lastUpdatedTick: 15,
    memberCountAtJoin: members,
    lastObservedMemberCount: members,
    conversationSatisfaction: 1,
  };
}

function makeState(overrides: Partial<SimulationState>): SimulationState {
  return {
    tick: 0,
    agents: [],
    groupCandidates: [],
    log: [],
    width: 800,
    height: 520,
    finished: false,
    seed: 3,
    formationScenarioId: "standingParty",
    ...overrides,
  };
}

function step(
  state: SimulationState,
  formation: FormationRuntimeOptions,
  rng = new SeededRandom(1),
  params: SimParams = DEFAULT_PARAMS,
): SimulationState {
  return stepSimulation(state, params, rng, undefined, undefined, undefined, undefined, undefined, formation);
}

function events(state: SimulationState, eventType: string, agentId?: string) {
  return state.log.filter(
    (entry) => entry.eventType === eventType && (agentId === undefined || entry.metadata?.agentId === agentId),
  );
}

function visitIdOf(state: SimulationState, eventType: string, agentId: string): string | undefined {
  return events(state, eventType, agentId)[0]?.metadata?.venueVisitId;
}

describe("Issue #267: ドリンク取得から別clusterへの再合流", () => {
  it("thirstが閾値を超えると輪を離れ、受け取ったあと別の輪へjoinし、episodeとcontactが閉じる", () => {
    const formation = quietStanding(venueConfig());
    const traveler = makeAgent({
      state: "joined",
      joinedGroupId: "group-a",
      clusterJoinedAtTick: 0,
      x: 400,
      y: 260,
      currentEpisode: episode("agent-a", "group-a", 2),
    });
    const partner = makeAgent({
      id: "agent-b",
      label: "B",
      state: "joined",
      joinedGroupId: "group-a",
      clusterJoinedAtTick: 0,
      x: 412,
      y: 260,
      initiative: 0.2,
      currentEpisode: episode("agent-b", "group-a", 2),
    });
    const host = makeAgent({
      id: "agent-c",
      label: "C",
      state: "joined",
      joinedGroupId: "group-b",
      clusterJoinedAtTick: 0,
      x: 680,
      y: 120,
      initiative: 0.2,
      currentEpisode: episode("agent-c", "group-b", 1),
    });
    const groupA: GroupCandidate = {
      id: "group-a",
      x: 400,
      y: 260,
      memberIds: ["agent-a", "agent-b"],
      status: "confirmed",
      age: 20,
      everConfirmed: true,
      minGroupSize: 1,
    };
    const groupB: GroupCandidate = {
      id: "group-b",
      x: 680,
      y: 120,
      memberIds: ["agent-c"],
      status: "confirmed",
      age: 10,
      everConfirmed: true,
      minGroupSize: 1,
      maxGroupSize: 6,
    };
    const start = makeState({
      tick: 15,
      agents: [traveler, partner, host],
      groupCandidates: [groupA, groupB],
      standingPartyConfig: formation.standingPartyConfig,
      venueRuntimeState: {
        needs: {
          "agent-a": { hunger: 0.2, thirst: 0.697, hungerRate: 1, thirstRate: 1 },
          "agent-b": { hunger: 0.1, thirst: 0.1, hungerRate: 1, thirstRate: 1 },
          "agent-c": { hunger: 0.1, thirst: 0.1, hungerRate: 1, thirstRate: 1 },
        },
        visits: {},
      },
    });
    expect(start.venueRuntimeState?.needs["agent-a"].thirst).toBeLessThan(DEFAULT_VENUE_ANCHOR_CONFIG.needs.visitThreshold);

    const rng = new SeededRandom(1);
    let state = start;
    let left: SimulationState | undefined;
    let rejoined: SimulationState | undefined;
    for (let i = 0; i < 90 && !rejoined; i++) {
      state = step(state, formation, rng);
      const person = state.agents.find((agent) => agent.id === "agent-a")!;
      if (!left && person.state === "undecided" && state.venueRuntimeState?.visits["agent-a"]) left = state;
      if (person.state === "joined" && person.joinedGroupId === "group-b") rejoined = state;
    }

    expect(left, "閾値超過の次tickで飲食離脱する").toBeDefined();
    const breakTick = left!.tick;
    expect(left!.venueRuntimeState?.needs["agent-a"].thirst).toBeGreaterThanOrEqual(
      DEFAULT_VENUE_ANCHOR_CONFIG.needs.visitThreshold,
    );
    expect(left!.venueRuntimeState?.visits["agent-a"]).toMatchObject({
      phase: "traveling",
      anchorId: MVP_DRINK_ANCHOR.id,
      purpose: "drink",
      visitId: `agent-a:${MVP_DRINK_ANCHOR.id}:${breakTick}`,
    });
    expect(events(left!, "clusterDepartureStarted", "agent-a")).toHaveLength(0);
    expect(events(left!, "venueVisitStarted", "agent-a")[0]?.metadata).toMatchObject({
      episodeId: "agent-a:group-a:0",
      episodeEndReason: "venueRefreshmentBreak",
      venueAnchorKind: "drink",
      venueVisitId: `agent-a:${MVP_DRINK_ANCHOR.id}:${breakTick}`,
    });
    const history = buildStandingPartyConversationHistory(left!);
    expect(history.episodes.find((item) => item.episodeId === "agent-a:group-a:0")).toMatchObject({
      endReason: "venueRefreshmentBreak",
      endedAtTick: breakTick,
    });
    const network = buildStandingPartyContactNetwork(left!);
    const contact = network.contactIntervals.find(
      (interval) => interval.agentIdA === "agent-a" && interval.agentIdB === "agent-b" && interval.clusterId === "group-a",
    );
    expect(contact).toMatchObject({
      contactIntervalId: createContactIntervalId("agent-a", "agent-b", "group-a", 0),
      endedAtTick: breakTick,
      status: "completed",
    });
    expect(left!.agents.find((agent) => agent.id === "agent-b")?.joinedGroupId).toBe("group-a");

    const done = state.log.filter((entry) => entry.eventType === "venueVisitCompleted" && entry.metadata?.agentId === "agent-a");
    expect(done).toHaveLength(1);
    const sharedId = `agent-a:${MVP_DRINK_ANCHOR.id}:${breakTick}`;
    expect(visitIdOf(state, "venueVisitStarted", "agent-a")).toBe(sharedId);
    expect(visitIdOf(state, "venueVisitArrived", "agent-a")).toBe(sharedId);
    expect(visitIdOf(state, "refreshmentObtained", "agent-a")).toBe(sharedId);
    expect(visitIdOf(state, "venueVisitCompleted", "agent-a")).toBe(sharedId);
    const obtainedTick = events(state, "refreshmentObtained", "agent-a")[0]?.tick ?? breakTick;
    expect(obtainedTick).toBeGreaterThan(breakTick);
    expect(state.venueRuntimeState?.needs["agent-a"].thirst).toBeLessThan(0.7);
    expect(state.venueRuntimeState?.needs["agent-a"].drinkCooldownUntilTick).toBeGreaterThan(obtainedTick);

    expect(rejoined, "受け取り後に別clusterへjoinする").toBeDefined();
    const rejoinedAgent = rejoined!.agents.find((agent) => agent.id === "agent-a")!;
    expect(rejoinedAgent.joinedGroupId).toBe("group-b");
    expect(rejoinedAgent.currentEpisode?.episodeId).not.toBe("agent-a:group-a:0");
    expect(rejoinedAgent.currentEpisode?.clusterId).toBe("group-b");
    const after = buildStandingPartyContactNetwork(rejoined!);
    expect(
      after.contactIntervals.find((interval) => interval.contactIntervalId === contact?.contactIntervalId)?.endedAtTick,
    ).toBe(breakTick);
  });
});

describe("Issue #267: 料理台の到達と境界", () => {
  it("hungerで料理台へ向かい、受け取って別の輪へ戻る", () => {
    const formation = quietStanding(venueConfig());
    const traveler = makeAgent({
      state: "joined",
      joinedGroupId: "group-a",
      clusterJoinedAtTick: 0,
      currentEpisode: episode("agent-a", "group-a", 2),
    });
    const partner = makeAgent({
      id: "agent-b",
      label: "B",
      state: "joined",
      joinedGroupId: "group-a",
      clusterJoinedAtTick: 0,
      x: 412,
      y: 260,
      currentEpisode: episode("agent-b", "group-a", 2),
    });
    const host = makeAgent({
      id: "agent-c",
      label: "C",
      state: "joined",
      joinedGroupId: "group-b",
      clusterJoinedAtTick: 0,
      x: 140,
      y: 400,
      currentEpisode: episode("agent-c", "group-b", 1),
    });
    const start = makeState({
      tick: 15,
      agents: [traveler, partner, host],
      groupCandidates: [
        {
          id: "group-a",
          x: 400,
          y: 260,
          memberIds: ["agent-a", "agent-b"],
          status: "confirmed",
          age: 20,
          everConfirmed: true,
          minGroupSize: 1,
        },
        {
          id: "group-b",
          x: 140,
          y: 400,
          memberIds: ["agent-c"],
          status: "confirmed",
          age: 8,
          everConfirmed: true,
          minGroupSize: 1,
          maxGroupSize: 6,
        },
      ],
      standingPartyConfig: formation.standingPartyConfig,
      venueRuntimeState: {
        needs: {
          "agent-a": { hunger: 0.697, thirst: 0.05, hungerRate: 1, thirstRate: 1 },
          "agent-b": { hunger: 0.1, thirst: 0.1, hungerRate: 1, thirstRate: 1 },
          "agent-c": { hunger: 0.1, thirst: 0.1, hungerRate: 1, thirstRate: 1 },
        },
        visits: {},
      },
    });

    const rng = new SeededRandom(2);
    let state = start;
    let rejoined: SimulationState | undefined;
    for (let i = 0; i < 90 && !rejoined; i++) {
      state = step(state, formation, rng);
      const person = state.agents.find((agent) => agent.id === "agent-a")!;
      if (person.state === "joined" && person.joinedGroupId === "group-b") rejoined = state;
    }

    expect(events(state, "venueVisitStarted", "agent-a")[0]?.metadata?.venueAnchorKind).toBe("food");
    expect(events(state, "refreshmentObtained", "agent-a")).toHaveLength(1);
    expect(state.venueRuntimeState?.needs["agent-a"].hunger).toBeLessThan(0.7);
    expect(rejoined?.agents.find((agent) => agent.id === "agent-a")?.currentEpisode?.clusterId).toBe("group-b");
    expect(distance(MVP_FOOD_ANCHOR.x, MVP_FOOD_ANCHOR.y, 140, 400)).toBeGreaterThan(MVP_FOOD_ANCHOR.interactionRadius);
  });

  it("未所属からの同時訪問、満席、台の不在、移動TTL、cooldown、pause-resume、resetを区別する", () => {
    const both = quietStanding(venueConfig());
    const direct = step(
      makeState({
        agents: [makeAgent({ id: "solo", label: "S", x: 200, y: 300, state: "undecided" })],
        standingPartyConfig: both.standingPartyConfig,
        venueRuntimeState: {
          needs: { solo: { hunger: 0.95, thirst: 0.1, hungerRate: 1, thirstRate: 1 } },
          visits: {},
        },
      }),
      both,
    );
    expect(direct.venueRuntimeState?.visits.solo).toMatchObject({ purpose: "food", phase: "traveling" });
    expect(events(direct, "venueVisitStarted", "solo")[0]?.metadata?.episodeId).toBeUndefined();

    const anchors: VenueAnchor[] = [{ ...MVP_FOOD_ANCHOR, capacity: 1, serviceTicks: 2 }];
    const crowded = quietStanding(venueConfig({ anchors }));
    const ids = ["a", "b"];
    const visits: Record<string, PendingVenueVisit> = {};
    for (const id of ids) {
      visits[id] = {
        visitId: `${id}:${MVP_FOOD_ANCHOR.id}:4`,
        anchorId: MVP_FOOD_ANCHOR.id,
        purpose: "food",
        startedAtTick: 4,
        phase: "traveling",
        phaseEnteredAtTick: 4,
        decisionReason: "selectedFood",
      };
    }
    const simultaneous = step(
      makeState({
        tick: 4,
        agents: ids.map((id) => makeAgent({ id, label: id, x: MVP_FOOD_ANCHOR.x, y: MVP_FOOD_ANCHOR.y })),
        standingPartyConfig: crowded.standingPartyConfig,
        venueRuntimeState: {
          needs: Object.fromEntries(ids.map((id) => [id, { hunger: 0.4, thirst: 0.1, hungerRate: 1, thirstRate: 1 }])),
          visits,
        },
      }),
      crowded,
    );
    expect(simultaneous.venueRuntimeState?.visits.a?.phase).toBe("receiving");
    expect(simultaneous.venueRuntimeState?.visits.b).toBeUndefined();
    expect(events(simultaneous, "venueVisitArrived", "a")).toHaveLength(1);
    expect(events(simultaneous, "venueVisitAbandoned", "b")[0]?.metadata?.venueVisitAbandonReason).toBe("anchorAtCapacity");

    const missingFormation = quietStanding(venueConfig({ anchors: [{ ...MVP_FOOD_ANCHOR }] }));
    const missing = step(
      makeState({
        agents: [makeAgent({ x: 400, y: 260 })],
        standingPartyConfig: missingFormation.standingPartyConfig,
        venueRuntimeState: {
          needs: { "agent-a": { hunger: 0.1, thirst: 0.2, hungerRate: 1, thirstRate: 1 } },
          visits: {
            "agent-a": {
              visitId: "agent-a:anchor:drink-main:1",
              anchorId: MVP_DRINK_ANCHOR.id,
              purpose: "drink",
              startedAtTick: 1,
              phase: "traveling",
              phaseEnteredAtTick: 1,
              decisionReason: "selectedDrink",
            },
          },
        },
      }),
      missingFormation,
    );
    expect(events(missing, "venueVisitAbandoned")[0]?.metadata?.venueVisitAbandonReason).toBe("anchorMissing");
    expect(missing.agents[0].x).toBeCloseTo(400, 6);

    const timed = quietStanding(
      venueConfig({ visit: { ...DEFAULT_VENUE_ANCHOR_CONFIG.visit, maxTravelTicks: 5 } }),
    );
    const timedOut = step(
      makeState({
        agents: [makeAgent({ x: 400, y: 260 })],
        standingPartyConfig: timed.standingPartyConfig,
        venueRuntimeState: {
          needs: { "agent-a": { hunger: 0.2, thirst: 0.2, hungerRate: 1, thirstRate: 1 } },
          visits: {
            "agent-a": {
              visitId: "agent-a:anchor:food-main:1",
              anchorId: MVP_FOOD_ANCHOR.id,
              purpose: "food",
              startedAtTick: -4,
              phase: "traveling",
              phaseEnteredAtTick: -4,
              decisionReason: "selectedFood",
            },
          },
        },
      }),
      timed,
    );
    expect(events(timedOut, "venueVisitAbandoned")[0]?.metadata?.venueVisitAbandonReason).toBe("travelTimedOut");

    const cooled = quietStanding(
      venueConfig({
        anchors: [{ ...MVP_FOOD_ANCHOR, serviceTicks: 1 }, { ...MVP_DRINK_ANCHOR, serviceTicks: 1 }],
        visit: { ...DEFAULT_VENUE_ANCHOR_CONFIG.visit, consumeTicks: 1, revisitCooldownTicks: 40 },
        needs: { ...DEFAULT_VENUE_ANCHOR_CONFIG.needs, needAfterRefill: 0.69, hungerGainPerTick: 0.05, thirstGainPerTick: 0.001 },
      }),
    );
    const ate = step(
      makeState({
        agents: [makeAgent({ x: MVP_FOOD_ANCHOR.x, y: MVP_FOOD_ANCHOR.y })],
        standingPartyConfig: cooled.standingPartyConfig,
        venueRuntimeState: {
          needs: { "agent-a": { hunger: 0.95, thirst: 0.1, hungerRate: 1, thirstRate: 1 } },
          visits: {},
        },
      }),
      cooled,
    );
    expect(events(ate, "refreshmentObtained")).toHaveLength(1);
    const held = step(ate, cooled);
    expect(held.venueRuntimeState?.lastDecisions?.["agent-a"].reason).toBe("revisitCooldown");
    expect(events(held, "venueVisitStarted")).toHaveLength(1);

    const paused = makeState({
      tick: 8,
      agents: [makeAgent({ x: 300, y: 200 })],
      standingPartyConfig: both.standingPartyConfig,
      venueRuntimeState: {
        needs: { "agent-a": { hunger: 0.2, thirst: 0.9, hungerRate: 1, thirstRate: 1 } },
        visits: {},
      },
    });
    const resumeA = step(paused, both, new SeededRandom(9));
    const resumeB = step(paused, both, new SeededRandom(9));
    expect(resumeA.agents).toEqual(resumeB.agents);
    expect(resumeA.venueRuntimeState).toEqual(resumeB.venueRuntimeState);
    expect(resumeA.log).toEqual(resumeB.log);

    const reset = createInitialState(9, DEFAULT_PARAMS, undefined, undefined, undefined, undefined, undefined, both);
    expect(reset.venueRuntimeState?.visits).toEqual({});
    expect(reset.tick).toBe(0);
    expect(reset.agents.every((agent) => agent.joinedGroupId === undefined)).toBe(true);
  });
});

describe("Issue #267: 台の近接と会話再形成", () => {
  it("サービス中の近さはcontactにも情報伝播にもならず、完了後の正式な輪だけがcontactを開く", () => {
    const formation = quietStanding(venueConfig({ encounterEnabled: true }));
    const params: SimParams = { ...DEFAULT_PARAMS, groupConfirmSize: 2 };
    const agents = [
      makeAgent({ id: "agent-a", label: "A", x: MVP_DRINK_ANCHOR.x, y: MVP_DRINK_ANCHOR.y, initiative: 0.4 }),
      makeAgent({
        id: "agent-b",
        label: "B",
        x: MVP_DRINK_ANCHOR.x + 0.4,
        y: MVP_DRINK_ANCHOR.y,
        initiative: 0.35,
      }),
    ];
    const receiving: Record<string, PendingVenueVisit> = {};
    for (const agent of agents) {
      receiving[agent.id] = {
        visitId: `${agent.id}:${MVP_DRINK_ANCHOR.id}:20`,
        anchorId: MVP_DRINK_ANCHOR.id,
        purpose: "drink",
        startedAtTick: 20,
        phase: "receiving",
        phaseEnteredAtTick: 30,
        decisionReason: "selectedDrink",
      };
    }
    let state = makeState({
      tick: 30,
      agents,
      standingPartyConfig: formation.standingPartyConfig,
      venueAnchors: MVP_VENUE_ANCHORS.map((anchor) => ({ ...anchor })),
      venueRuntimeState: {
        needs: {
          "agent-a": { hunger: 0.2, thirst: 0.9, hungerRate: 1, thirstRate: 1 },
          "agent-b": { hunger: 0.2, thirst: 0.9, hungerRate: 1, thirstRate: 1 },
        },
        visits: receiving,
      },
    });
    state = step(state, formation, new SeededRandom(5), params);
    const nearA = state.agents.find((agent) => agent.id === "agent-a")!;
    const nearB = state.agents.find((agent) => agent.id === "agent-b")!;
    expect(distance(nearA.x, nearA.y, nearB.x, nearB.y)).toBeLessThan(MVP_DRINK_ANCHOR.interactionRadius);
    expect(buildStandingPartyContactNetwork(state).contactIntervals).toHaveLength(0);
    expect(state.contentUtteranceLog ?? []).toHaveLength(0);
    expect(state.informationReceptionLog ?? []).toHaveLength(0);
    expect(state.log.some((entry) => entry.eventType === "venueEncounterFormed")).toBe(false);

    let formed: SimulationState | undefined;
    const rng = new SeededRandom(5);
    for (let i = 0; i < 20 && !formed; i++) {
      state = step(state, formation, rng, params);
      if (state.log.some((entry) => entry.eventType === "venueEncounterFormed")) formed = state;
    }
    expect(formed, "訪問完了後に通常のGroupCandidateができる").toBeDefined();
    const formedEvent = formed!.log.find((entry) => entry.eventType === "venueEncounterFormed");
    expect(formedEvent?.metadata?.venueEncounterReason).toBe("postVisitGreeting");
    const group = formed!.groupCandidates.find((candidate) => candidate.id === formedEvent?.metadata?.groupId);
    expect(group?.status === "forming" || group?.status === "confirmed").toBe(true);
    expect(distance(group!.x, group!.y, MVP_DRINK_ANCHOR.x, MVP_DRINK_ANCHOR.y)).toBeGreaterThanOrEqual(
      MVP_DRINK_ANCHOR.interactionRadius + 20 - 1e-6,
    );

    let joined = formed!;
    let contactTick: number | undefined;
    for (let i = 0; i < 40 && contactTick === undefined; i++) {
      joined = step(joined, formation, rng, params);
      const network = buildStandingPartyContactNetwork(joined);
      if (network.contactIntervals.length > 0) contactTick = network.contactIntervals[0]?.startedAtTick;
    }
    expect(contactTick).toBeGreaterThan(30);
    expect(joined.contentUtteranceLog ?? []).toHaveLength(0);
    expect(joined.log.some((entry) => entry.eventType === "refreshmentObtained")).toBe(true);
  });
});

const POLICY = getFormationPolicyById("standingParty");

function countCompletions(state: SimulationState, kind: "food" | "drink"): number {
  return state.log.filter(
    (entry) => entry.eventType === "venueVisitCompleted" && entry.metadata?.venueAnchorKind === kind,
  ).length;
}

function assertVisitCadence(state: SimulationState, config: VenueAnchorConfig): void {
  const open = new Set<string>();
  const lastTerminal = new Map<string, { tick: number; completed: boolean }>();
  const arrivedAt = new Map<string, number>();
  const serviceTicks = new Map(config.anchors.map((anchor) => [anchor.id, anchor.serviceTicks]));
  for (const entry of state.log) {
    const agentId = entry.metadata?.agentId;
    const kind = entry.metadata?.venueAnchorKind;
    const visitId = entry.metadata?.venueVisitId;
    if (!agentId || !kind || !visitId) continue;
    const key = `${agentId}:${kind}`;
    if (entry.eventType === "venueVisitStarted") {
      const previous = lastTerminal.get(key);
      if (previous) {
        const minGap = previous.completed ? config.visit.revisitCooldownTicks : config.visit.failedVisitCooldownTicks;
        expect(entry.tick - previous.tick, `${key} がcooldown前に同じ台へ戻った`).toBeGreaterThanOrEqual(minGap);
      }
      expect(open.has(key), `${key} の前の訪問が閉じる前に次が始まった`).toBe(false);
      open.add(key);
    }
    if (entry.eventType === "venueVisitArrived") arrivedAt.set(visitId, entry.tick);
    if (entry.eventType === "refreshmentObtained") {
      const startedReceiving = arrivedAt.get(visitId);
      const anchorId = entry.metadata?.venueAnchorId;
      const limit = anchorId ? serviceTicks.get(anchorId) : undefined;
      if (startedReceiving !== undefined && limit !== undefined) {
        expect(entry.tick - startedReceiving + 1, `${visitId} のserviceが延びている`).toBeLessThanOrEqual(limit);
      }
    }
    if (entry.eventType === "venueVisitCompleted" || entry.eventType === "venueVisitAbandoned") {
      open.delete(key);
      lastTerminal.set(key, { tick: entry.tick, completed: entry.eventType === "venueVisitCompleted" });
    }
  }
}

describe("Issue #267: 長時間の安定性とON/OFF", () => {
  it("1000tick・複数seedで座標・訪問寿命・clusterが壊れない", { timeout: 60_000 }, () => {
    const preset = getPresetById("standing-party-spatial-roaming");
    const base = preset.formationStandingPartyConfig ?? SPATIAL_ROAMING_STANDING_PARTY_CONFIG;
    const config = venueConfig({ encounterEnabled: true });
    const formation: FormationRuntimeOptions = {
      scenarioId: "standingParty",
      standingPartyConfig: { ...base, venueAnchors: config },
    };
    for (const seed of [11, 42]) {
      const rng = new SeededRandom(seed);
      let state = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);
      let activeTicks = 0;
      let lateActiveTicks = 0;
      for (let i = 0; i < 1000; i++) {
        state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
        assertStandingPartyInvariants(state, { maxEmptyFormingAge: POLICY.defaultMaxAge, label: `seed ${seed} tick ${state.tick}` });
        assertStandingPartySpatialInvariants(state, formation.standingPartyConfig!.spatialDynamics, `seed ${seed} tick ${state.tick}`);
        const active = state.groupCandidates.some((candidate) => candidate.status === "forming" || candidate.status === "confirmed");
        if (active) activeTicks += 1;
        if (i >= 800 && active) lateActiveTicks += 1;
        for (const visit of Object.values(state.venueRuntimeState?.visits ?? {})) {
          const anchor = config.anchors.find((item) => item.id === visit.anchorId);
          const phaseLimit =
            visit.phase === "traveling"
              ? config.visit.maxTravelTicks
              : visit.phase === "receiving"
                ? (anchor?.serviceTicks ?? 1)
                : config.visit.consumeTicks;
          expect(state.tick - visit.phaseEnteredAtTick + 1, `${visit.visitId} が ${visit.phase} のまま残っている`).toBeLessThanOrEqual(
            phaseLimit,
          );
        }
      }
      assertVisitCadence(state, config);
      expect(countCompletions(state, "food") + countCompletions(state, "drink"), `seed ${seed}`).toBeGreaterThan(0);
      expect(activeTicks, `seed ${seed} で社会的clusterが一度もできない`).toBeGreaterThan(50);
      expect(lateActiveTicks, `seed ${seed} の終盤で社会的clusterが消えたまま`).toBeGreaterThan(0);
      const obtains = state.log.filter((entry) => entry.eventType === "refreshmentObtained").length;
      expect(obtains).toBeLessThan(1000);
    }
  });

  it("固定seedではONだけが飲食を完了し、cluster・episode・contactも残る", { timeout: 60_000 }, () => {
    const preset = getPresetById("standing-party-spatial-roaming");
    const base = preset.formationStandingPartyConfig ?? SPATIAL_ROAMING_STANDING_PARTY_CONFIG;
    const seeds = [11, 42, 77];
    const ticks = 500;
    const run = (seed: number, enabled: boolean) => {
      const formation: FormationRuntimeOptions = {
        scenarioId: "standingParty",
        standingPartyConfig: {
          ...base,
          venueAnchors: enabled ? venueConfig({ encounterEnabled: true }) : venueConfig({ enabled: false, anchors: [], encounterEnabled: false }),
        },
      };
      const rng = new SeededRandom(seed);
      let state = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);
      const zones = new Map<string, Set<string>>();
      let activeTicks = 0;
      for (let i = 0; i < ticks; i++) {
        state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
        if (state.groupCandidates.some((candidate) => candidate.status === "forming" || candidate.status === "confirmed")) {
          activeTicks += 1;
        }
        if (i % 25 === 0) {
          for (const agent of state.agents) {
            if (!Number.isFinite(agent.x) || !Number.isFinite(agent.y)) continue;
            const zone = `${agent.x < 400 ? "W" : "E"}${agent.y < 260 ? "N" : "S"}`;
            const seen = zones.get(agent.id) ?? new Set<string>();
            seen.add(zone);
            zones.set(agent.id, seen);
          }
        }
      }
      const history = buildStandingPartyConversationHistory(state);
      const network = buildStandingPartyContactNetwork(state);
      return {
        food: countCompletions(state, "food"),
        drink: countCompletions(state, "drink"),
        venueEvents: state.log.filter((entry) => entry.tags.includes("venueVisit")).length,
        multiZoneAgents: [...zones.values()].filter((zone) => zone.size >= 2).length,
        activeTicks,
        episodes: history.episodes.length,
        contacts: network.contactIntervals.length,
      };
    };

    const on = seeds.map((seed) => run(seed, true));
    const off = seeds.map((seed) => run(seed, false));
    const sum = (rows: typeof on, key: keyof (typeof on)[number]) => rows.reduce((total, row) => total + row[key], 0);

    expect(sum(on, "food"), `ON food ${JSON.stringify(on)}`).toBeGreaterThan(0);
    expect(sum(on, "drink"), `ON drink ${JSON.stringify(on)}`).toBeGreaterThan(0);
    expect(sum(on, "multiZoneAgents")).toBeGreaterThanOrEqual(4);
    expect(on.every((row) => row.activeTicks > 0)).toBe(true);
    expect(sum(on, "episodes")).toBeGreaterThan(0);
    expect(sum(on, "contacts")).toBeGreaterThan(0);
    expect(sum(off, "venueEvents"), `OFFは飲食eventを出さない ${JSON.stringify(off)}`).toBe(0);
    expect(off.every((row) => row.activeTicks > 0)).toBe(true);
  });

  it("Phase 7を無効にするとPhase 6の座標・所属・event・情報伝播・PRNGが一致する", { timeout: 60_000 }, () => {
    const quietVenue = venueConfig({ enabled: false, anchors: [], encounterEnabled: false });
    const noisyVenue = venueConfig({
      enabled: false,
      encounterEnabled: true,
      anchors: MVP_VENUE_ANCHORS.map((anchor) => ({ ...anchor, serviceTicks: 1 })),
      needs: { ...DEFAULT_VENUE_ANCHOR_CONFIG.needs, hungerGainPerTick: 0.2, thirstGainPerTick: 0.2, visitThreshold: 0.01 },
      visit: { ...DEFAULT_VENUE_ANCHOR_CONFIG.visit, approachSpeed: 14, revisitCooldownTicks: 1, maxTravelTicks: 5 },
    });
    const cases: Array<{ name: string; base: StandingPartyScenarioConfig; params: SimParams }> = [
      {
        name: "spatial-roaming",
        base: SPATIAL_ROAMING_STANDING_PARTY_CONFIG,
        params: getPresetById("standing-party-spatial-roaming").params,
      },
      {
        name: "info-rich+spatial",
        base: {
          ...INFO_RICH_STANDING_PARTY_CONFIG,
          spatialDynamics: SPATIAL_ROAMING_STANDING_PARTY_CONFIG.spatialDynamics,
        },
        params: getPresetById("standing-party-info-rich").params,
      },
    ];

    for (const item of cases) {
      for (const seed of [5, 11]) {
        const run = (venue: VenueAnchorConfig) => {
          const formation: FormationRuntimeOptions = {
            scenarioId: "standingParty",
            standingPartyConfig: { ...item.base, venueAnchors: venue },
          };
          const rng = new SeededRandom(seed);
          let state = createInitialState(seed, item.params, undefined, undefined, undefined, undefined, undefined, formation);
          for (let i = 0; i < 200; i++) {
            state = stepSimulation(state, item.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
          }
          return { state, draw: rng.next() };
        };
        const left = run(quietVenue);
        const right = run(noisyVenue);
        expect(right.draw, item.name).toBe(left.draw);
        expect(right.state.venueRuntimeState, item.name).toBeUndefined();
        expect(right.state.venueAnchors, item.name).toBeUndefined();
        expect(fingerprint(right.state), `${item.name} seed ${seed}`).toEqual(fingerprint(left.state));
      }
    }

    for (const scenarioId of ["afterParty", "classroomPair"] as const) {
      const params = scenarioId === "classroomPair" ? getPresetById("classroom-pair").params : getPresetById("natural").params;
      const enabled: FormationRuntimeOptions = {
        scenarioId,
        standingPartyConfig: { ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG, venueAnchors: venueConfig({ encounterEnabled: true }) },
      };
      const baseline: FormationRuntimeOptions = { scenarioId };
      const rngOn = new SeededRandom(4);
      const rngOff = new SeededRandom(4);
      let on = createInitialState(4, params, undefined, undefined, undefined, undefined, undefined, enabled);
      let off = createInitialState(4, params, undefined, undefined, undefined, undefined, undefined, baseline);
      for (let i = 0; i < 40; i++) {
        on = stepSimulation(on, params, rngOn, undefined, undefined, undefined, undefined, undefined, enabled);
        off = stepSimulation(off, params, rngOff, undefined, undefined, undefined, undefined, undefined, baseline);
      }
      expect(on.venueRuntimeState).toBeUndefined();
      expect(on.log.some((entry) => entry.tags.includes("venueVisit"))).toBe(false);
      expect(fingerprint(on)).toEqual(fingerprint(off));
      expect(rngOn.next()).toBe(rngOff.next());
    }
  });
});

function fingerprint(state: SimulationState) {
  return {
    agents: state.agents.map((agent) => ({
      id: agent.id,
      x: agent.x,
      y: agent.y,
      vx: agent.vx,
      vy: agent.vy,
      state: agent.state,
      joinedGroupId: agent.joinedGroupId,
      stress: agent.stress,
      episodeId: agent.currentEpisode?.episodeId,
    })),
    groups: state.groupCandidates.map((candidate) => ({
      id: candidate.id,
      x: candidate.x,
      y: candidate.y,
      status: candidate.status,
      memberIds: [...candidate.memberIds].sort(),
    })),
    events: state.log.map((entry) => ({ tick: entry.tick, eventType: entry.eventType, message: entry.message })),
    utterances: state.contentUtteranceLog ?? [],
    receptions: state.informationReceptionLog ?? [],
    adoptions: state.informationAdoptionLog ?? [],
    speech: (state.speechLog ?? []).map((event) => ({ id: event.id, tick: event.tick, speakerId: event.speakerId, reason: event.reason })),
  };
}
