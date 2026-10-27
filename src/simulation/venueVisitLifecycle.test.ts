import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { getFormationPolicyById, type FormationRuntimeOptions } from "./formationPolicy";
import { distance } from "./model";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS, getPresetById } from "./presets";
import { DEFAULT_SPATIAL_DYNAMICS_CONFIG } from "./spatialDynamics";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG } from "./standingPartyScenarioConfig";
import { buildStandingPartyConversationHistory } from "./standingPartyAnalysis";
import { assertStandingPartyInvariants, assertStandingPartySpatialInvariants } from "./standingPartyInvariants";
import type { Agent, GroupCandidate, SimulationState } from "./types";
import {
  DEFAULT_VENUE_ANCHOR_CONFIG,
  MVP_DRINK_ANCHOR,
  MVP_FOOD_ANCHOR,
  MVP_VENUE_ANCHORS,
  type PendingVenueVisit,
  type VenueAnchor,
  type VenueAnchorConfig,
} from "./venueAnchors";
import { applyVenueTravelStep } from "./venueVisitRuntime";

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

function standing(config: VenueAnchorConfig, spatialEnabled = false): FormationRuntimeOptions {
  return {
    scenarioId: "standingParty",
    standingPartyConfig: {
      ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
      spatialDynamics: { ...DEFAULT_SPATIAL_DYNAMICS_CONFIG, enabled: spatialEnabled },
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
    willingness: 0.9,
    initiative: 0.1,
    ambiguityTolerance: 0.5,
    influenceAvoidance: 0.3,
    conformity: 0.9,
    leaveThreshold: 0.8,
    isObserverJoiner: false,
    state: "undecided",
    stress: 0.1,
    socialCirculationTendency: 0,
    ...overrides,
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

function step(state: SimulationState, formation: FormationRuntimeOptions, rng = new SeededRandom(1)): SimulationState {
  return stepSimulation(state, DEFAULT_PARAMS, rng, undefined, undefined, undefined, undefined, undefined, formation);
}

function events(state: SimulationState, eventType: string, agentId?: string) {
  return state.log.filter(
    (entry) => entry.eventType === eventType && (agentId === undefined || entry.metadata?.agentId === agentId),
  );
}

class AlwaysApproach extends SeededRandom {
  override chance(): boolean {
    return true;
  }
}

describe("venue visit movement (Issue #264)", () => {
  it("直進はapproachSpeedを超えず、会場の外へ出ない", () => {
    const agent = { x: 6, y: 6, vx: 0, vy: 0 };
    applyVenueTravelStep(agent, { x: 5, y: 5 }, 10, { fx: -100, fy: -100 });
    expect(Math.hypot(agent.vx, agent.vy)).toBeLessThanOrEqual(10 + 1e-9);
    expect(agent.x).toBeGreaterThanOrEqual(5);
    expect(agent.y).toBeGreaterThanOrEqual(5);
    expect(agent.x).toBeLessThanOrEqual(795);
    expect(agent.y).toBeLessThanOrEqual(515);

    const straight = { x: 400, y: 260, vx: 0, vy: 0 };
    applyVenueTravelStep(straight, MVP_DRINK_ANCHOR, 10);
    expect(Math.hypot(straight.vx, straight.vy)).toBeCloseTo(10, 6);
    expect(distance(straight.x, straight.y, MVP_DRINK_ANCHOR.x, MVP_DRINK_ANCHOR.y)).toBeLessThan(
      distance(400, 260, MVP_DRINK_ANCHOR.x, MVP_DRINK_ANCHOR.y),
    );
  });

  it("joinedから離脱して受け取り、回遊へ戻る決定的fixture", () => {
    const formation = standing(venueConfig());
    const agent = makeAgent({
      state: "joined",
      joinedGroupId: "group-a",
      clusterJoinedAtTick: 0,
      stress: 0.1,
      leaveThreshold: 0.8,
      currentEpisode: {
        episodeId: "agent-a:group-a:0",
        clusterId: "group-a",
        joinedAtTick: 0,
        lastUpdatedTick: 15,
        memberCountAtJoin: 1,
        lastObservedMemberCount: 1,
        conversationSatisfaction: 1,
      },
    });
    const candidate: GroupCandidate = {
      id: "group-a",
      x: 400,
      y: 260,
      memberIds: ["agent-a"],
      status: "confirmed",
      age: 20,
      everConfirmed: true,
      // 既定の成立最小人数は3。1人の輪を飲食離脱まで維持し、抜けたあと空clusterとして消す。
      minGroupSize: 1,
    };
    const start = makeState({
      tick: 15,
      agents: [agent],
      groupCandidates: [candidate],
      standingPartyConfig: formation.standingPartyConfig,
      venueRuntimeState: {
        needs: { "agent-a": { hunger: 0.2, thirst: 0.7, hungerRate: 1, thirstRate: 1 } },
        visits: {},
      },
    });

    const off = step(start, standing(venueConfig({ enabled: false, anchors: [] })));
    expect(off.agents[0].state).toBe("joined");
    expect(off.log.some((entry) => String(entry.eventType).startsWith("venue"))).toBe(false);

    let state = start;
    const seen = new Map<number, SimulationState>();
    for (let i = 0; i < 45; i++) {
      state = step(state, formation, new SeededRandom(1));
      seen.set(state.tick, state);
    }

    const started = seen.get(16)!;
    expect(started.agents[0].state).toBe("undecided");
    expect(started.agents[0].joinedGroupId).toBeUndefined();
    expect(started.agents[0].currentEpisode).toBeUndefined();
    expect(started.agents[0].clusterDepartureCount ?? 0).toBe(0);
    expect(started.agents[0].lastDepartedClusterId).toBe("group-a");
    expect(started.agents[0].stress).toBeCloseTo(0.1, 8);
    expect(started.venueRuntimeState?.visits["agent-a"]).toMatchObject({
      phase: "traveling",
      anchorId: "anchor:drink-main",
      purpose: "drink",
      startedAtTick: 16,
    });
    expect(events(started, "clusterDepartureStarted")).toHaveLength(0);
    expect(events(started, "clusterMemberReleased")).toHaveLength(0);
    expect(events(started, "venueVisitStarted")[0]?.metadata).toMatchObject({
      episodeId: "agent-a:group-a:0",
      episodeEndReason: "venueRefreshmentBreak",
      venueAnchorKind: "drink",
    });
    expect(started.groupCandidates.find((item) => item.id === "group-a")?.status).toBe("dissolved");
    expect(events(started, "activeClusterDissolved")).toHaveLength(1);

    const history = buildStandingPartyConversationHistory(started);
    expect(history.episodes.find((episode) => episode.episodeId === "agent-a:group-a:0")?.endReason).toBe(
      "venueRefreshmentBreak",
    );
    expect(history.clusterLifetimes.every((life) => life.voluntaryLeaveCount === 0)).toBe(true);
    expect(history.schemaVersion).toBe(2);

    const arrived = seen.get(51)!;
    expect(arrived.venueRuntimeState?.visits["agent-a"]?.phase).toBe("receiving");
    expect(events(arrived, "venueVisitArrived")).toHaveLength(1);
    expect(distance(arrived.agents[0].x, arrived.agents[0].y, MVP_DRINK_ANCHOR.x, MVP_DRINK_ANCHOR.y)).toBeLessThanOrEqual(
      MVP_DRINK_ANCHOR.interactionRadius,
    );
    expect(Math.hypot(arrived.agents[0].x - 707.37, arrived.agents[0].y - 72.58)).toBeLessThan(1);

    const obtained = seen.get(54)!;
    expect(obtained.venueRuntimeState?.visits["agent-a"]?.phase).toBe("consuming");
    expect(obtained.venueRuntimeState?.needs["agent-a"].thirst).toBeCloseTo(0.15, 8);
    expect(obtained.venueRuntimeState?.needs["agent-a"].hunger).toBeCloseTo(0.2 + (54 - 15) * 0.0032, 8);
    expect(events(obtained, "refreshmentObtained")).toHaveLength(1);

    const done = seen.get(56)!;
    expect(done.venueRuntimeState?.visits["agent-a"]).toBeUndefined();
    expect(done.agents[0].state).toBe("undecided");
    expect(done.agents[0].stress).toBeCloseTo(0.1, 8);
    expect(done.venueRuntimeState?.needs["agent-a"].drinkCooldownUntilTick).toBe(111);
    expect(events(done, "venueVisitCompleted")).toHaveLength(1);
    expect(events(done, "refreshmentObtained")).toHaveLength(1);

    const resumed = seen.get(57)!;
    expect(resumed.agents[0].stress).toBeGreaterThan(0.1);
    expect(resumed.venueRuntimeState?.visits["agent-a"]).toBeUndefined();
    expect(resumed.venueRuntimeState?.lastDecisions?.["agent-a"].action).not.toMatch(/^start/);
    expect(resumed.log.filter((entry) => entry.eventType === "venueVisitStarted")).toHaveLength(1);
  });

  it("未所属から直接訪問し、満席では待たず、移動時間超過と台の消失では放棄する", () => {
    const formation = standing(venueConfig());
    const direct = step(
      makeState({
        agents: [makeAgent({ x: 400, y: 260 })],
        standingPartyConfig: formation.standingPartyConfig,
        venueRuntimeState: {
          needs: { "agent-a": { hunger: 0.2, thirst: 0.9, hungerRate: 1, thirstRate: 1 } },
          visits: {},
        },
      }),
      formation,
    );
    expect(direct.venueRuntimeState?.visits["agent-a"]?.purpose).toBe("drink");
    expect(events(direct, "venueVisitStarted")[0]?.metadata?.groupId).toBeUndefined();
    expect(direct.agents[0].state).toBe("undecided");

    const anchors: VenueAnchor[] = [{ ...MVP_DRINK_ANCHOR, capacity: 3 }];
    const crowded = standing(venueConfig({ anchors }));
    const ids = ["a", "b", "c", "d"];
    const visits: Record<string, PendingVenueVisit> = {};
    for (const id of ids) {
      visits[id] = {
        visitId: `${id}:${MVP_DRINK_ANCHOR.id}:1`,
        anchorId: MVP_DRINK_ANCHOR.id,
        purpose: "drink",
        startedAtTick: 1,
        phase: "traveling",
        phaseEnteredAtTick: 1,
        decisionReason: "selectedDrink",
      };
    }
    const arrived = step(
      makeState({
        tick: 1,
        agents: ids.map((id) => makeAgent({ id, label: id, x: MVP_DRINK_ANCHOR.x, y: MVP_DRINK_ANCHOR.y })),
        standingPartyConfig: crowded.standingPartyConfig,
        venueRuntimeState: {
          needs: Object.fromEntries(ids.map((id) => [id, { hunger: 0.2, thirst: 0.4, hungerRate: 1, thirstRate: 1 }])),
          visits,
        },
      }),
      crowded,
    );
    const receiving = Object.values(arrived.venueRuntimeState?.visits ?? {}).filter((visit) => visit.phase === "receiving");
    expect(receiving).toHaveLength(3);
    expect(arrived.venueRuntimeState?.visits.d).toBeUndefined();
    expect(events(arrived, "venueVisitAbandoned", "d")[0]?.metadata?.venueVisitAbandonReason).toBe("anchorAtCapacity");
    expect(arrived.venueRuntimeState?.needs.d.drinkCooldownUntilTick).toBe(2 + 12);
    expect(arrived.agents.find((agent) => agent.id === "d")?.state).toBe("undecided");

    const timedOut = step(
      makeState({
        agents: [makeAgent({ x: 400, y: 260 })],
        standingPartyConfig: standing(venueConfig({ visit: { ...DEFAULT_VENUE_ANCHOR_CONFIG.visit, maxTravelTicks: 5 } }))
          .standingPartyConfig,
        venueRuntimeState: {
          needs: { "agent-a": { hunger: 0.2, thirst: 0.4, hungerRate: 1, thirstRate: 1 } },
          visits: {
            "agent-a": {
              visitId: "agent-a:anchor:drink-main:1",
              anchorId: MVP_DRINK_ANCHOR.id,
              purpose: "drink",
              startedAtTick: -4,
              phase: "traveling",
              phaseEnteredAtTick: -4,
              decisionReason: "selectedDrink",
            },
          },
        },
      }),
      standing(venueConfig({ visit: { ...DEFAULT_VENUE_ANCHOR_CONFIG.visit, maxTravelTicks: 5 } })),
    );
    expect(timedOut.venueRuntimeState?.visits["agent-a"]).toBeUndefined();
    expect(events(timedOut, "venueVisitAbandoned")[0]?.metadata?.venueVisitAbandonReason).toBe("travelTimedOut");
    expect(timedOut.agents[0].x).toBeGreaterThanOrEqual(5);
    expect(timedOut.agents[0].x).toBeLessThanOrEqual(795);
    expect(timedOut.agents[0].state).toBe("undecided");

    const missingFormation = standing(venueConfig({ anchors: [{ ...MVP_FOOD_ANCHOR }] }));
    const before = makeAgent({ x: 400, y: 260 });
    const missing = step(
      makeState({
        agents: [before],
        standingPartyConfig: missingFormation.standingPartyConfig,
        venueRuntimeState: {
          needs: { "agent-a": { hunger: 0.1, thirst: 0.4, hungerRate: 1, thirstRate: 1 } },
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
    expect(missing.agents[0].x).toBeCloseTo(400, 6);
    expect(missing.agents[0].y).toBeCloseTo(260, 6);
    expect(missing.venueRuntimeState?.visits["agent-a"]).toBeUndefined();
    expect(events(missing, "venueVisitAbandoned")[0]?.metadata?.venueVisitAbandonReason).toBe("anchorMissing");
    expect(missing.venueRuntimeState?.needs["agent-a"].drinkCooldownUntilTick).toBe(1 + 12);
    expect(missing.venueRuntimeState?.needs["agent-a"].foodCooldownUntilTick).toBeUndefined();
  });

  it("目的移動中は近くの会話へ寄り道せず、空間回遊が目的地を奪わない", () => {
    const formation = standing(venueConfig());
    const group: GroupCandidate = {
      id: "group-near",
      x: 420,
      y: 260,
      memberIds: ["host"],
      status: "confirmed",
      age: 5,
      everConfirmed: true,
      maxGroupSize: 6,
    };
    const diverted = step(
      makeState({
        agents: [
          makeAgent({
            x: 400,
            y: 260,
            willingness: 1,
            conformity: 1,
          }),
          makeAgent({ id: "host", label: "H", x: 420, y: 260, state: "joined", joinedGroupId: "group-near" }),
        ],
        groupCandidates: [group],
        standingPartyConfig: formation.standingPartyConfig,
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
      formation,
      new AlwaysApproach(1),
    );
    expect(diverted.agents[0].state).toBe("undecided");
    expect(diverted.agents[0].pendingClusterTransition).toBeUndefined();
    expect(diverted.venueRuntimeState?.visits["agent-a"]?.anchorId).toBe(MVP_DRINK_ANCHOR.id);
    expect(group.memberIds).not.toContain("agent-a");

    const spatial = standing(venueConfig(), true);
    const before = distance(400, 260, MVP_DRINK_ANCHOR.x, MVP_DRINK_ANCHOR.y);
    const roamed = step(
      makeState({
        agents: [
          makeAgent({ id: "agent-a", x: 400, y: 260 }),
          makeAgent({ id: "agent-b", label: "B", x: 200, y: 200 }),
        ],
        standingPartyConfig: spatial.standingPartyConfig,
        venueRuntimeState: {
          needs: {
            "agent-a": { hunger: 0.2, thirst: 0.2, hungerRate: 1, thirstRate: 1 },
            "agent-b": { hunger: 0.2, thirst: 0.2, hungerRate: 1, thirstRate: 1 },
          },
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
      spatial,
    );
    const traveler = roamed.agents.find((agent) => agent.id === "agent-a")!;
    const moved = distance(400, 260, traveler.x, traveler.y);
    expect(moved).toBeGreaterThan(6);
    expect(moved).toBeLessThanOrEqual(10 + 1e-6);
    expect(distance(traveler.x, traveler.y, MVP_DRINK_ANCHOR.x, MVP_DRINK_ANCHOR.y)).toBeLessThan(before);
    expect(roamed.spatialRuntimeState?.roaming["agent-a"]).toBeUndefined();
    expect(roamed.spatialRuntimeState?.roaming["agent-b"]).toBeDefined();
  });

  it("受け取りは1回だけで、成功cooldown中は同じ台へ戻らず、もう一方の台へは向かえる", () => {
    const quickAnchors = [
      { ...MVP_FOOD_ANCHOR, serviceTicks: 1 },
      { ...MVP_DRINK_ANCHOR, serviceTicks: 1 },
    ];
    const formation = standing(
      venueConfig({
        anchors: quickAnchors,
        visit: { ...DEFAULT_VENUE_ANCHOR_CONFIG.visit, consumeTicks: 1, revisitCooldownTicks: 40 },
        needs: { ...DEFAULT_VENUE_ANCHOR_CONFIG.needs, needAfterRefill: 0.69, thirstGainPerTick: 0.05, hungerGainPerTick: 0.001 },
      }),
    );
    const first = step(
      makeState({
        agents: [makeAgent({ x: MVP_DRINK_ANCHOR.x, y: MVP_DRINK_ANCHOR.y })],
        standingPartyConfig: formation.standingPartyConfig,
        venueRuntimeState: {
          needs: { "agent-a": { hunger: 0.1, thirst: 0.9, hungerRate: 1, thirstRate: 1 } },
          visits: {},
        },
      }),
      formation,
    );
    expect(first.venueRuntimeState?.visits["agent-a"]).toBeUndefined();
    expect(events(first, "refreshmentObtained")).toHaveLength(1);
    expect(first.venueRuntimeState?.needs["agent-a"].thirst).toBeCloseTo(0.69, 8);
    expect(first.venueRuntimeState?.needs["agent-a"].drinkCooldownUntilTick).toBe(41);
    expect(first.agents[0].stress).toBeCloseTo(0.1, 8);

    const blocked = step(first, formation);
    expect(blocked.venueRuntimeState?.visits["agent-a"]).toBeUndefined();
    expect(blocked.venueRuntimeState?.lastDecisions?.["agent-a"].reason).toBe("revisitCooldown");
    expect(events(blocked, "refreshmentObtained")).toHaveLength(1);

    const foodFirst = standing(
      venueConfig({
        anchors: quickAnchors,
        visit: { ...DEFAULT_VENUE_ANCHOR_CONFIG.visit, consumeTicks: 1 },
      }),
    );
    const ate = step(
      makeState({
        agents: [makeAgent({ x: MVP_FOOD_ANCHOR.x, y: MVP_FOOD_ANCHOR.y })],
        standingPartyConfig: foodFirst.standingPartyConfig,
        venueRuntimeState: {
          needs: { "agent-a": { hunger: 0.95, thirst: 0.8, hungerRate: 1, thirstRate: 1 } },
          visits: {},
        },
      }),
      foodFirst,
    );
    expect(events(ate, "venueVisitStarted")[0]?.metadata?.venueAnchorKind).toBe("food");
    expect(ate.venueRuntimeState?.needs["agent-a"].hunger).toBeCloseTo(0.15, 8);
    expect(ate.venueRuntimeState?.needs["agent-a"].thirst).toBeGreaterThan(0.8);
    const drankNext = step(ate, foodFirst);
    expect(drankNext.venueRuntimeState?.visits["agent-a"]).toMatchObject({
      purpose: "drink",
      anchorId: MVP_DRINK_ANCHOR.id,
      phase: "traveling",
    });
  });

  it("訪問中は会場退出のstressを積まず、同じtickのcluster解散で二重に解放しない", () => {
    const quick = standing(
      venueConfig({
        anchors: [{ ...MVP_DRINK_ANCHOR, serviceTicks: 1 }],
        visit: { ...DEFAULT_VENUE_ANCHOR_CONFIG.visit, consumeTicks: 1 },
      }),
    );
    const atBar = step(
      makeState({
        agents: [makeAgent({ x: MVP_DRINK_ANCHOR.x, y: MVP_DRINK_ANCHOR.y, stress: 0.95 })],
        standingPartyConfig: quick.standingPartyConfig,
        venueRuntimeState: {
          needs: { "agent-a": { hunger: 0.1, thirst: 0.9, hungerRate: 1, thirstRate: 1 } },
          visits: {},
        },
      }),
      quick,
    );
    expect(atBar.agents[0].state).toBe("undecided");
    expect(atBar.agents[0].stress).toBeCloseTo(0.95, 8);
    expect(atBar.venueRuntimeState?.visits["agent-a"]).toBeUndefined();
    const left = step(atBar, quick);
    expect(left.agents[0].state).toBe("leaving");

    const formation = standing(venueConfig());
    const other = makeAgent({
      id: "agent-b",
      label: "B",
      state: "joined",
      joinedGroupId: "group-a",
      clusterJoinedAtTick: 0,
      currentEpisode: {
        episodeId: "agent-b:group-a:0",
        clusterId: "group-a",
        joinedAtTick: 0,
        lastUpdatedTick: 20,
        memberCountAtJoin: 2,
        lastObservedMemberCount: 2,
        conversationSatisfaction: 1,
      },
    });
    const leader = makeAgent({
      state: "joined",
      joinedGroupId: "group-a",
      clusterJoinedAtTick: 0,
      currentEpisode: {
        episodeId: "agent-a:group-a:0",
        clusterId: "group-a",
        joinedAtTick: 0,
        lastUpdatedTick: 20,
        memberCountAtJoin: 2,
        lastObservedMemberCount: 2,
        conversationSatisfaction: 1,
      },
    });
    const dissolved = step(
      makeState({
        tick: 20,
        agents: [leader, other],
        groupCandidates: [
          {
            id: "group-a",
            x: 400,
            y: 260,
            memberIds: ["agent-a", "agent-b"],
            status: "confirmed",
            age: 10,
            everConfirmed: true,
            minGroupSize: 2,
          },
        ],
        standingPartyConfig: formation.standingPartyConfig,
        venueRuntimeState: {
          needs: {
            "agent-a": { hunger: 0.2, thirst: 0.9, hungerRate: 1, thirstRate: 1 },
            "agent-b": { hunger: 0.1, thirst: 0.1, hungerRate: 1, thirstRate: 1 },
          },
          visits: {},
        },
      }),
      formation,
    );
    expect(dissolved.venueRuntimeState?.visits["agent-a"]?.purpose).toBe("drink");
    expect(dissolved.agents.find((agent) => agent.id === "agent-a")?.joinedGroupId).toBeUndefined();
    expect(events(dissolved, "clusterMemberReleased").map((entry) => entry.metadata?.agentId)).toEqual(["agent-b"]);
    expect(events(dissolved, "venueVisitStarted", "agent-a")).toHaveLength(1);
    expect(events(dissolved, "clusterDepartureStarted", "agent-a")).toHaveLength(0);
  });

  it("同じstateから再開した訪問は同じphaseと座標になり、resetでは訪問が残らない", () => {
    const formation = standing(venueConfig());
    const start = makeState({
      tick: 15,
      agents: [makeAgent({ state: "undecided" })],
      standingPartyConfig: formation.standingPartyConfig,
      venueRuntimeState: {
        needs: { "agent-a": { hunger: 0.2, thirst: 0.9, hungerRate: 1, thirstRate: 1 } },
        visits: {},
      },
    });
    const mid = step(start, formation, new SeededRandom(4));
    const againA = step(mid, formation, new SeededRandom(9));
    const againB = step(mid, formation, new SeededRandom(9));
    expect(againA.agents[0]).toEqual(againB.agents[0]);
    expect(againA.venueRuntimeState).toEqual(againB.venueRuntimeState);

    const reset = createInitialState(4, DEFAULT_PARAMS, undefined, undefined, undefined, undefined, undefined, formation);
    expect(reset.venueRuntimeState?.visits).toEqual({});
    expect(reset.agents.every((agent) => agent.pendingClusterTransition === undefined)).toBe(true);
  });

  it("有効な1000tickでも訪問の孤児・NaN・無限待ちがない", () => {
    const preset = getPresetById("standing-party-spatial-roaming");
    const base = preset.formationStandingPartyConfig ?? DEFAULT_STANDING_PARTY_SCENARIO_CONFIG;
    const formation: FormationRuntimeOptions = {
      scenarioId: "standingParty",
      standingPartyConfig: {
        ...base,
        venueAnchors: venueConfig(),
      },
    };
    const policy = getFormationPolicyById("standingParty");
    const rng = new SeededRandom(11);
    let state = createInitialState(11, preset.params, undefined, undefined, undefined, undefined, undefined, formation);
    for (let i = 0; i < 1000; i++) {
      state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
      assertStandingPartyInvariants(state, { maxEmptyFormingAge: policy.defaultMaxAge, label: `tick ${state.tick}` });
      assertStandingPartySpatialInvariants(state, formation.standingPartyConfig!.spatialDynamics, `tick ${state.tick}`);
    }
    expect(state.log.some((entry) => entry.eventType === "venueVisitCompleted")).toBe(true);
    expect(state.log.some((entry) => entry.eventType === "refreshmentObtained")).toBe(true);
    const obtained = new Map<string, number>();
    for (const entry of state.log) {
      if (entry.eventType !== "refreshmentObtained" || !entry.metadata?.venueVisitId) continue;
      obtained.set(entry.metadata.venueVisitId, (obtained.get(entry.metadata.venueVisitId) ?? 0) + 1);
    }
    expect([...obtained.values()].every((count) => count === 1)).toBe(true);
  });
});
