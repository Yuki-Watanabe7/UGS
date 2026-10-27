import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import type { FormationRuntimeOptions } from "./formationPolicy";
import { distance } from "./model";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS } from "./presets";
import { DEFAULT_SPATIAL_DYNAMICS_CONFIG } from "./spatialDynamics";
import { buildStandingPartyContactNetwork } from "./standingPartyAnalysis";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG } from "./standingPartyScenarioConfig";
import type { Agent, GroupCandidate, SimulationState, SimParams } from "./types";
import {
  DEFAULT_VENUE_ANCHOR_CONFIG,
  MVP_DRINK_ANCHOR,
  MVP_VENUE_ANCHORS,
  type PendingVenueVisit,
  type VenueAnchorConfig,
} from "./venueAnchors";
import {
  applyVenueStayPositions,
  evaluateEncounterOpportunity,
  nudgeClusterFromAnchors,
  resolveEncounterClusterCenter,
  VENUE_ENCOUNTER_SCORE_THRESHOLD,
  VENUE_STAY_OFFSET_RADIUS,
  venueStayOffset,
  type VenueEncounterAgentView,
  type VenueEncounterPresence,
} from "./venueEncounter";

function venueConfig(overrides: Partial<VenueAnchorConfig> = {}): VenueAnchorConfig {
  return {
    ...DEFAULT_VENUE_ANCHOR_CONFIG,
    enabled: true,
    anchors: MVP_VENUE_ANCHORS.map((anchor) => ({ ...anchor })),
    ...overrides,
    needs: { ...DEFAULT_VENUE_ANCHOR_CONFIG.needs, ...overrides.needs },
    visit: { ...DEFAULT_VENUE_ANCHOR_CONFIG.visit, ...overrides.visit },
    encounter: { ...DEFAULT_VENUE_ANCHOR_CONFIG.encounter, ...overrides.encounter },
  };
}

function standing(config: VenueAnchorConfig): FormationRuntimeOptions {
  return {
    scenarioId: "standingParty",
    standingPartyConfig: {
      ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
      spatialDynamics: { ...DEFAULT_SPATIAL_DYNAMICS_CONFIG, enabled: false },
      venueAnchors: config,
    },
  };
}

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-a",
    label: "A",
    x: MVP_DRINK_ANCHOR.x,
    y: MVP_DRINK_ANCHOR.y,
    vx: 0,
    vy: 0,
    willingness: 0.95,
    initiative: 0.4,
    ambiguityTolerance: 0.5,
    influenceAvoidance: 0.05,
    conformity: 0.95,
    leaveThreshold: 0.8,
    isObserverJoiner: false,
    state: "undecided",
    stress: 0.1,
    socialCirculationTendency: 0,
    ...overrides,
  };
}

function view(overrides: Partial<VenueEncounterAgentView> = {}): VenueEncounterAgentView {
  return {
    id: "agent-a",
    label: "A",
    x: 100,
    y: 100,
    state: "undecided",
    initiative: 0.4,
    willingness: 0.95,
    conformity: 0.95,
    influenceAvoidance: 0.05,
    isObserverJoiner: false,
    pendingSocialTransition: false,
    blockedCandidateIds: [],
    ...overrides,
  };
}

function service(anchorId: string, obtained: boolean): VenueEncounterPresence {
  return { kind: "service", anchorId, obtained };
}

function makeState(overrides: Partial<SimulationState>): SimulationState {
  return {
    tick: 30,
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

const PARAMS: SimParams = { ...DEFAULT_PARAMS, groupConfirmSize: 2 };

function step(state: SimulationState, formation: FormationRuntimeOptions, rng = new SeededRandom(1)): SimulationState {
  return stepSimulation(state, PARAMS, rng, undefined, undefined, undefined, undefined, undefined, formation);
}

function visit(agentId: string, phase: PendingVenueVisit["phase"], phaseEnteredAtTick: number): PendingVenueVisit {
  return {
    visitId: `${agentId}:anchor:drink-main:20`,
    anchorId: MVP_DRINK_ANCHOR.id,
    purpose: "drink",
    startedAtTick: 20,
    phase,
    phaseEnteredAtTick,
    decisionReason: "selectedDrink",
  };
}

function pairAtDrink(encounterEnabled: boolean) {
  const formation = standing(venueConfig({ encounterEnabled }));
  const agents = [
    makeAgent({ id: "agent-a", label: "A", initiative: 0.4 }),
    makeAgent({ id: "agent-b", label: "B", x: MVP_DRINK_ANCHOR.x + 0.5, y: MVP_DRINK_ANCHOR.y, initiative: 0.35 }),
  ];
  const state = makeState({
    agents,
    venueAnchors: MVP_VENUE_ANCHORS.map((anchor) => ({ ...anchor })),
    venueRuntimeState: {
      needs: {
        "agent-a": { hunger: 0.2, thirst: 0.9, hungerRate: 1, thirstRate: 1 },
        "agent-b": { hunger: 0.2, thirst: 0.9, hungerRate: 1, thirstRate: 1 },
      },
      visits: {
        "agent-a": visit("agent-a", "receiving", 30),
        "agent-b": visit("agent-b", "receiving", 30),
      },
    },
  });
  return { formation, state };
}

describe("venue encounter opportunity (Issue #265)", () => {
  it("agent idから半径18以内の別位置を決める", () => {
    const a = venueStayOffset("agent-a");
    const b = venueStayOffset("agent-b");
    expect(Math.hypot(a.dx, a.dy)).toBeLessThanOrEqual(VENUE_STAY_OFFSET_RADIUS);
    expect(Math.hypot(b.dx, b.dy)).toBeGreaterThanOrEqual(VENUE_STAY_OFFSET_RADIUS * 0.55 - 1e-9);
    expect(a).not.toEqual(b);
    expect(venueStayOffset("agent-a")).toEqual(a);

    const agents = [
      { id: "agent-a", x: 0, y: 0, vx: 1, vy: 1 },
      { id: "agent-b", x: 0, y: 0, vx: 1, vy: 1 },
    ];
    applyVenueStayPositions(
      agents,
      {
        "agent-a": { phase: "receiving", anchorId: MVP_DRINK_ANCHOR.id },
        "agent-b": { phase: "receiving", anchorId: MVP_DRINK_ANCHOR.id },
      },
      [MVP_DRINK_ANCHOR],
    );
    expect(distance(agents[0].x, agents[0].y, agents[1].x, agents[1].y)).toBeGreaterThan(1);
    for (const agent of agents) {
      expect(distance(agent.x, agent.y, MVP_DRINK_ANCHOR.x, MVP_DRINK_ANCHOR.y)).toBeLessThanOrEqual(
        MVP_DRINK_ANCHOR.interactionRadius,
      );
      expect(agent.vx).toBe(0);
    }
  });

  it("observerJoinerでも同じscoreになり、サービス中は輪を作らない", () => {
    const a = view();
    const b = view({ id: "agent-b", label: "B", x: 110, y: 100, initiative: 0.35 });
    const shared = {
      presenceA: service("anchor:drink-main", false),
      presenceB: service("anchor:drink-main", false),
      tick: 10,
      radius: 48,
      windowTicks: 8,
      existingTieStrength: 0.2,
    };
    const plain = evaluateEncounterOpportunity({ a, b, ...shared });
    const observer = evaluateEncounterOpportunity({
      a: { ...a, isObserverJoiner: true },
      b,
      ...shared,
    });
    expect(observer.score).toBe(plain.score);
    expect(observer.initiatorId).toBe(plain.initiatorId);
    expect(observer.initiatorId).toBe("agent-a");
    expect(plain.eligible).toBe(false);
    expect(plain.reason).toBe("serviceInProgress");
    expect(plain.phase).toBe("beforeObtain");
    expect(plain.score).toBeGreaterThanOrEqual(VENUE_ENCOUNTER_SCORE_THRESHOLD);
  });

  it("社会的な開きが小さい二人は、重なっていても輪の対象にしない", () => {
    const result = evaluateEncounterOpportunity({
      a: view({ willingness: 0.15, conformity: 0.2, influenceAvoidance: 0.9, initiative: 0.15 }),
      b: view({
        id: "agent-b",
        label: "B",
        willingness: 0.15,
        conformity: 0.2,
        influenceAvoidance: 0.9,
        initiative: 0.1,
      }),
      presenceA: { kind: "postVisit", anchorId: "anchor:drink-main", completedAtTick: 10 },
      presenceB: { kind: "postVisit", anchorId: "anchor:drink-main", completedAtTick: 10 },
      tick: 12,
      radius: 48,
      windowTicks: 8,
      existingTieStrength: 0,
    });
    expect(result.observed).toBe(true);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("belowSocialThreshold");
  });

  it("別の台、または窓の外では機会にしない", () => {
    const a = view();
    const b = view({ id: "agent-b", label: "B", x: 110, y: 100 });
    const differentAnchor = evaluateEncounterOpportunity({
      a,
      b,
      presenceA: service("anchor:drink-main", true),
      presenceB: service("anchor:food-main", true),
      tick: 10,
      radius: 48,
      windowTicks: 8,
      existingTieStrength: 0,
    });
    expect(differentAnchor.observed).toBe(false);

    const expired = evaluateEncounterOpportunity({
      a,
      b,
      presenceA: { kind: "postVisit", anchorId: "anchor:drink-main", completedAtTick: 1 },
      presenceB: { kind: "postVisit", anchorId: "anchor:drink-main", completedAtTick: 1 },
      tick: 20,
      radius: 48,
      windowTicks: 8,
      existingTieStrength: 0,
    });
    expect(expired.observed).toBe(false);
  });

  it("同じtopicと同cliqueはscoreを上げ、不一致は下げる", () => {
    const baseInput = {
      a: view({ topicId: "weather", cliqueId: 1, willingness: 0.5, conformity: 0.5, influenceAvoidance: 0.4, initiative: 0.4 }),
      b: view({
        id: "agent-b",
        label: "B",
        x: 120,
        y: 100,
        topicId: "weather",
        cliqueId: 1,
        willingness: 0.5,
        conformity: 0.5,
        influenceAvoidance: 0.4,
        initiative: 0.4,
      }),
      presenceA: { kind: "postVisit" as const, anchorId: "anchor:drink-main", completedAtTick: 4 },
      presenceB: { kind: "postVisit" as const, anchorId: "anchor:drink-main", completedAtTick: 4 },
      tick: 6,
      radius: 48,
      windowTicks: 8,
      existingTieStrength: 0.8,
    };
    const matched = evaluateEncounterOpportunity(baseInput);
    const mismatched = evaluateEncounterOpportunity({
      ...baseInput,
      b: { ...baseInput.b, topicId: "sports", cliqueId: 2 },
    });
    expect(matched.score).toBeGreaterThan(mismatched.score);
    expect(matched.eligible).toBe(true);
    expect(matched.reason).toBe("postVisitGreeting");
  });

  it("新しい輪の中心は台の円の外で、中に入った中心は外へ戻る", () => {
    const center = resolveEncounterClusterCenter(MVP_DRINK_ANCHOR, [MVP_DRINK_ANCHOR, MVP_DRINK_ANCHOR], 20);
    const clearance = MVP_DRINK_ANCHOR.interactionRadius + 20;
    expect(distance(center.x, center.y, MVP_DRINK_ANCHOR.x, MVP_DRINK_ANCHOR.y)).toBeGreaterThanOrEqual(clearance - 1e-6);
    expect(center.x).toBeGreaterThanOrEqual(20);
    expect(center.y).toBeGreaterThanOrEqual(20);

    let cluster = { x: MVP_DRINK_ANCHOR.x, y: MVP_DRINK_ANCHOR.y };
    for (let i = 0; i < 20; i++) {
      cluster = nudgeClusterFromAnchors(cluster, [MVP_DRINK_ANCHOR], 20);
    }
    expect(distance(cluster.x, cluster.y, MVP_DRINK_ANCHOR.x, MVP_DRINK_ANCHOR.y)).toBeGreaterThanOrEqual(clearance - 1e-6);
  });
});

describe("venue encounter runtime (Issue #265)", () => {
  it("サービス中は顔を合わせても輪に入らず、受け取り後に挨拶して輪を作る", () => {
    const { formation, state } = pairAtDrink(true);
    const during = step(state, formation);
    const a = during.agents.find((agent) => agent.id === "agent-a")!;
    const b = during.agents.find((agent) => agent.id === "agent-b")!;
    expect(a.state).toBe("undecided");
    expect(b.state).toBe("undecided");
    expect(distance(a.x, a.y, b.x, b.y)).toBeGreaterThan(1);
    expect(during.groupCandidates.some((candidate) => candidate.memberIds.includes("agent-a"))).toBe(false);
    expect(during.log.some((entry) => entry.eventType === "venueEncounterOpportunity")).toBe(true);
    expect(during.log.some((entry) => entry.eventType === "venueEncounterFormed")).toBe(false);
    expect(during.speechLog ?? []).toHaveLength(0);
    expect(during.contentUtteranceLog ?? []).toHaveLength(0);
    expect(buildStandingPartyContactNetwork(during).contactIntervals).toHaveLength(0);
    const serviceEvent = during.log.find((entry) => entry.eventType === "venueEncounterOpportunity");
    expect(serviceEvent?.metadata?.venueEncounterReason).toBe("serviceInProgress");
    expect(serviceEvent?.metadata?.venueEncounterPhase).toBe("beforeObtain");

    let current = during;
    let formed: SimulationState | undefined;
    for (let i = 0; i < 12 && !formed; i++) {
      current = step(current, formation);
      if (current.log.some((entry) => entry.eventType === "venueEncounterFormed")) formed = current;
    }
    expect(formed, "visit完了後に輪が作られる").toBeDefined();
    const nucleus = formed!.log.find((entry) => entry.eventType === "nucleusCreated" && entry.tick === formed!.tick);
    const formedEvent = formed!.log.find((entry) => entry.eventType === "venueEncounterFormed");
    expect(nucleus?.metadata?.groupId).toBe(formedEvent?.metadata?.groupId);
    expect(formedEvent?.metadata?.venueEncounterReason).toBe("postVisitGreeting");
    const group = formed!.groupCandidates.find((candidate) => candidate.id === formedEvent?.metadata?.groupId);
    expect(group).toBeDefined();
    expect(distance(group!.x, group!.y, MVP_DRINK_ANCHOR.x, MVP_DRINK_ANCHOR.y)).toBeGreaterThanOrEqual(
      MVP_DRINK_ANCHOR.interactionRadius + 20 - 1e-6,
    );
    const speechReasons = new Set((formed!.speechLog ?? []).map((event) => event.reason));
    expect(formed!.contentUtteranceLog ?? []).toHaveLength(0);

    let joined = formed!;
    let contactTick: number | undefined;
    for (let i = 0; i < 40; i++) {
      joined = step(joined, formation);
      for (const event of joined.speechLog ?? []) speechReasons.add(event.reason);
      const network = buildStandingPartyContactNetwork(joined);
      if (network.contactIntervals.length > 0) {
        contactTick = network.contactIntervals[0]?.startedAtTick;
        break;
      }
    }
    expect(speechReasons.has("initiativeFormedCore")).toBe(true);
    expect(speechReasons.has("approachWelcome")).toBe(true);
    expect(speechReasons.has("joinGreeting")).toBe(true);
    expect(contactTick).toBeGreaterThan(during.tick);

    let roaming = joined;
    let leftStation = false;
    for (let i = 0; i < 180; i++) {
      roaming = step(roaming, formation);
      const far = roaming.agents.some(
        (agent) => distance(agent.x, agent.y, MVP_DRINK_ANCHOR.x, MVP_DRINK_ANCHOR.y) > MVP_DRINK_ANCHOR.interactionRadius,
      );
      if (far) {
        leftStation = true;
        break;
      }
    }
    expect(leftStation).toBe(true);
    for (const candidate of roaming.groupCandidates) {
      if (candidate.status !== "forming" && candidate.status !== "confirmed") continue;
      expect(distance(candidate.x, candidate.y, MVP_DRINK_ANCHOR.x, MVP_DRINK_ANCHOR.y)).toBeGreaterThanOrEqual(
        MVP_DRINK_ANCHOR.interactionRadius + 20 - 4,
      );
    }
  });

  it("機会を切ると、同じ初期状態でも輪も接触も作らない", () => {
    const on = pairAtDrink(true);
    const off = pairAtDrink(false);
    const onStep = step(on.state, on.formation);
    const offStep = step(off.state, off.formation);
    const onA = onStep.agents.find((agent) => agent.id === "agent-a")!;
    const onB = onStep.agents.find((agent) => agent.id === "agent-b")!;
    const offA = offStep.agents.find((agent) => agent.id === "agent-a")!;
    const offB = offStep.agents.find((agent) => agent.id === "agent-b")!;
    expect(distance(onA.x, onA.y, onB.x, onB.y)).toBeGreaterThan(distance(offA.x, offA.y, offB.x, offB.y));
    expect(offStep.log.some((entry) => entry.eventType === "venueEncounterOpportunity")).toBe(false);

    let current = offStep;
    for (let i = 0; i < 20; i++) current = step(current, off.formation);
    expect(current.log.some((entry) => entry.eventType === "venueEncounterFormed")).toBe(false);
    expect(current.log.some((entry) => entry.eventType === "nucleusCreated")).toBe(false);
    expect(current.groupCandidates).toHaveLength(0);
    expect(buildStandingPartyContactNetwork(current).contactIntervals).toHaveLength(0);
    expect(current.contentUtteranceLog ?? []).toHaveLength(0);
    expect(current.agents.every((agent) => agent.state === "undecided" || agent.state === "leaving")).toBe(true);
  });

  it("社会的scoreが低い二人は、同じ台で受け取り終えても輪を作らない", () => {
    const { formation, state } = pairAtDrink(true);
    for (const agent of state.agents) {
      agent.willingness = 0.15;
      agent.conformity = 0.2;
      agent.influenceAvoidance = 0.9;
      agent.initiative = 0.15;
    }
    let current = state;
    for (let i = 0; i < 16; i++) current = step(current, formation);
    expect(current.log.some((entry) => entry.metadata?.venueEncounterReason === "belowSocialThreshold")).toBe(true);
    expect(current.log.some((entry) => entry.eventType === "venueEncounterFormed")).toBe(false);
    expect(current.log.some((entry) => entry.eventType === "nucleusCreated")).toBe(false);
    expect(buildStandingPartyContactNetwork(current).contactIntervals).toHaveLength(0);
  });

  it("台の外に既にある輪があれば、新しい輪を増やさずそちらへ向かう", () => {
    const offset = venueStayOffset("agent-a");
    const length = Math.hypot(offset.dx, offset.dy) || 1;
    const clearance = MVP_DRINK_ANCHOR.interactionRadius + 20;
    const placeDistance = clearance + 1;
    const candidate: GroupCandidate = {
      id: "group-existing",
      x: MVP_DRINK_ANCHOR.x + (offset.dx / length) * placeDistance,
      y: MVP_DRINK_ANCHOR.y + (offset.dy / length) * placeDistance,
      memberIds: ["agent-c"],
      status: "confirmed",
      age: 3,
    };
    const { formation, state } = pairAtDrink(true);
    state.agents.push(
      makeAgent({
        id: "agent-c",
        label: "C",
        x: candidate.x,
        y: candidate.y,
        state: "joined",
        joinedGroupId: candidate.id,
        clusterJoinedAtTick: 30,
        initiative: 0.2,
      }),
    );
    state.groupCandidates = [candidate];
    state.venueRuntimeState!.needs["agent-c"] = { hunger: 0.1, thirst: 0.1, hungerRate: 1, thirstRate: 1 };

    let current = state;
    let approached = false;
    for (let i = 0; i < 16; i++) {
      current = step(current, formation);
      const a = current.agents.find((agent) => agent.id === "agent-a")!;
      if (a.joinedGroupId === "group-existing" && (a.state === "approaching" || a.state === "joined")) {
        approached = true;
        break;
      }
    }
    expect(approached).toBe(true);
    expect(current.groupCandidates.filter((item) => item.status === "forming" || item.status === "confirmed").map((item) => item.id)).toEqual([
      "group-existing",
    ]);
    expect(current.log.some((entry) => entry.eventType === "venueEncounterFormed")).toBe(false);
    const greeting = current.log.find((entry) => entry.metadata?.venueEncounterReason === "postVisitGreeting");
    expect(greeting?.metadata?.groupId).toBe("group-existing");
  });

  it("encounter無効のafterPartyは飲食eventを出さない", () => {
    const initial = createInitialState(4, DEFAULT_PARAMS, undefined, undefined, undefined, undefined, undefined, {
      scenarioId: "afterParty",
    });
    const next = stepSimulation(initial, DEFAULT_PARAMS, new SeededRandom(4));
    expect(next.venueRuntimeState).toBeUndefined();
    expect(next.log.some((entry) => String(entry.eventType).startsWith("venue"))).toBe(false);
  });
});
