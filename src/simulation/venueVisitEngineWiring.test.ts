import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { buildAgentInspection } from "./inspection";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS, getPresetById } from "./presets";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG } from "./standingPartyScenarioConfig";
import type { Agent, GroupCandidate, SimulationState } from "./types";
import type { PendingVenueVisit } from "./venueAnchors";
import type { FormationRuntimeOptions } from "./formationPolicy";
import {
  DEFAULT_VENUE_ANCHOR_CONFIG,
  MVP_DRINK_ANCHOR,
  MVP_FOOD_ANCHOR,
  MVP_VENUE_ANCHORS,
  type VenueAnchorConfig,
} from "./venueAnchors";
import { readVenueAgentReadout } from "./venueVisitDecision";

function venueConfig(overrides: Partial<VenueAnchorConfig> = {}): VenueAnchorConfig {
  return {
    ...DEFAULT_VENUE_ANCHOR_CONFIG,
    enabled: true,
    anchors: [...MVP_VENUE_ANCHORS],
    ...overrides,
    needs: { ...DEFAULT_VENUE_ANCHOR_CONFIG.needs, ...overrides.needs },
    visit: { ...DEFAULT_VENUE_ANCHOR_CONFIG.visit, ...overrides.visit },
  };
}

function standing(config: VenueAnchorConfig): FormationRuntimeOptions {
  return {
    scenarioId: "standingParty",
    standingPartyConfig: { ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG, venueAnchors: config },
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
    willingness: 0.5,
    initiative: 0.1,
    ambiguityTolerance: 0.5,
    influenceAvoidance: 0.3,
    conformity: 0.5,
    leaveThreshold: 0.8,
    isObserverJoiner: false,
    state: "undecided",
    stress: 0.1,
    socialCirculationTendency: 0,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<GroupCandidate> = {}): GroupCandidate {
  return {
    id: "group-a",
    x: 400,
    y: 260,
    memberIds: ["agent-a", "ghost-1", "ghost-2", "ghost-3"],
    status: "confirmed",
    age: 30,
    everConfirmed: true,
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

function withoutVenue(state: SimulationState): Omit<SimulationState, "venueRuntimeState" | "venueAnchors" | "standingPartyConfig"> {
  const copy: SimulationState = { ...state, agents: state.agents.map((agent) => ({ ...agent })) };
  delete copy.venueRuntimeState;
  delete copy.venueAnchors;
  delete copy.standingPartyConfig;
  return copy;
}

describe("venue need/decision engine wiring (Issue #263)", () => {
  const enabled = standing(venueConfig());
  const disabled = standing(venueConfig({ enabled: false, anchors: [] }));

  it("無効時はvenue stateを作らず、有効時と同じseedの行動・主系列乱数と一致する", () => {
    const preset = getPresetById("standing-party");
    const ticks = 30;
    const run = (formation: FormationRuntimeOptions) => {
      const rng = new SeededRandom(8);
      let state = createInitialState(8, preset.params, undefined, undefined, undefined, undefined, undefined, formation);
      for (let i = 0; i < ticks; i++) {
        state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
      }
      return { state, draw: rng.next() };
    };
    const on = run(enabled);
    const off = run(disabled);
    expect(off.state.venueRuntimeState).toBeUndefined();
    expect(off.state.venueAnchors).toBeUndefined();
    expect(on.state.venueRuntimeState).toBeDefined();
    expect(withoutVenue(on.state)).toEqual(withoutVenue(off.state));
    expect(on.draw).toBe(off.draw);
    expect(on.state.log.some((entry) => entry.eventType?.startsWith("venue"))).toBe(false);
  });

  it("afterPartyとclassroomPairではenabledでもneedもdecisionも作らない", () => {
    const venueOn = { ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG, venueAnchors: venueConfig() };
    for (const scenarioId of ["afterParty", "classroomPair"] as const) {
      const formation: FormationRuntimeOptions = { scenarioId, standingPartyConfig: venueOn };
      const baseline: FormationRuntimeOptions = {
        scenarioId,
        standingPartyConfig: { ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG, venueAnchors: DEFAULT_VENUE_ANCHOR_CONFIG },
      };
      const rngOn = new SeededRandom(2);
      const rngOff = new SeededRandom(2);
      let on = createInitialState(2, DEFAULT_PARAMS, undefined, undefined, undefined, undefined, undefined, formation);
      let off = createInitialState(2, DEFAULT_PARAMS, undefined, undefined, undefined, undefined, undefined, baseline);
      expect(on.venueRuntimeState).toBeUndefined();
      for (let i = 0; i < 5; i++) {
        on = stepSimulation(on, DEFAULT_PARAMS, rngOn, undefined, undefined, undefined, undefined, undefined, formation);
        off = stepSimulation(off, DEFAULT_PARAMS, rngOff, undefined, undefined, undefined, undefined, undefined, baseline);
      }
      expect(on.venueRuntimeState).toBeUndefined();
      expect(on.venueAnchors).toBeUndefined();
      expect(withoutVenue(on)).toEqual(withoutVenue(off));
      expect(rngOn.next()).toBe(rngOff.next());
    }
  });

  it("同一seedの初期needとdecisionは再現し、agentごとに個体差がある", () => {
    const first = createInitialState(21, DEFAULT_PARAMS, undefined, undefined, undefined, undefined, undefined, enabled);
    const second = createInitialState(21, DEFAULT_PARAMS, undefined, undefined, undefined, undefined, undefined, enabled);
    expect(first.venueRuntimeState?.needs).toEqual(second.venueRuntimeState?.needs);
    expect(first.venueAnchors?.map((anchor) => anchor.id)).toEqual(["anchor:food-main", "anchor:drink-main"]);
    const hungers = new Set(Object.values(first.venueRuntimeState!.needs).map((need) => need.hunger));
    expect(hungers.size).toBeGreaterThan(1);

    const rngA = new SeededRandom(21);
    const rngB = new SeededRandom(21);
    const steppedA = stepSimulation(first, DEFAULT_PARAMS, rngA, undefined, undefined, undefined, undefined, undefined, enabled);
    const steppedB = stepSimulation(second, DEFAULT_PARAMS, rngB, undefined, undefined, undefined, undefined, undefined, enabled);
    expect(steppedA.venueRuntimeState?.lastDecisions).toEqual(steppedB.venueRuntimeState?.lastDecisions);
    expect(steppedA.venueRuntimeState?.needs).toEqual(steppedB.venueRuntimeState?.needs);
  });

  it("閾値を超えた未所属agentの意図を記録するが、所属も座標規則も変えない", () => {
    const person = makeAgent({ id: "agent-a", x: 400, y: 260 });
    const formation = enabled;
    const state = makeState({
      agents: [person],
      seed: 4,
      standingPartyConfig: formation.standingPartyConfig,
      venueRuntimeState: {
        needs: { "agent-a": { hunger: 0.2, thirst: 0.8, hungerRate: 1, thirstRate: 1 } },
        visits: {},
      },
    });
    const rngOn = new SeededRandom(4);
    const rngOff = new SeededRandom(4);
    const on = step(state, formation, rngOn);
    const off = step({ ...state, venueRuntimeState: undefined }, disabled, rngOff);

    const decision = on.venueRuntimeState?.lastDecisions?.["agent-a"];
    expect(decision?.reason).toBe("selectedDrink");
    expect(decision?.anchorId).toBe(MVP_DRINK_ANCHOR.id);
    expect(decision?.action).toBe("startDrinkVisit");
    expect(on.venueRuntimeState?.needs["agent-a"].thirst).toBeCloseTo(0.8 + 0.004, 10);
    expect(on.venueRuntimeState?.needs["agent-a"].hunger).toBeCloseTo(0.2 + 0.0032, 10);
    expect(on.venueRuntimeState?.visits["agent-a"]).toBeUndefined();
    expect(on.agents[0].state).toBe("undecided");
    expect(on.agents[0].pendingClusterTransition).toBeUndefined();
    expect(on.log.some((entry) => String(entry.eventType).startsWith("venue"))).toBe(false);
    expect(withoutVenue(on)).toEqual(withoutVenue(off));
    expect(rngOn.next()).toBe(rngOff.next());
  });

  it("会話中の最低滞在では離脱せず、滞在後も愛着が高くても席は外さず意図だけを記録する", () => {
    const joined = makeAgent({
      state: "joined",
      joinedGroupId: "group-a",
      clusterJoinedAtTick: 0,
      socialCirculationTendency: 0,
      currentEpisode: {
        episodeId: "ep-1",
        clusterId: "group-a",
        joinedAtTick: 0,
        lastUpdatedTick: 0,
        memberCountAtJoin: 4,
        lastObservedMemberCount: 4,
        conversationSatisfaction: 1,
        attachment: {
          value: 0.99,
          initializedAtTick: 0,
          lastUpdatedAtTick: 0,
          lastObservedMemberCount: 4,
          foundingMemberIds: ["agent-a", "ghost-1", "ghost-2", "ghost-3"],
          lastFoundingPresentCount: 4,
          lastMemberArrivalAtTick: 0,
        },
      },
    });
    const base = makeState({
      tick: 0,
      agents: [joined],
      groupCandidates: [makeCandidate()],
      standingPartyConfig: enabled.standingPartyConfig,
      venueRuntimeState: {
        needs: { "agent-a": { hunger: 0.1, thirst: 0.95, hungerRate: 1, thirstRate: 1 } },
        visits: {},
      },
    });
    const early = step(base, enabled);
    expect(early.venueRuntimeState?.lastDecisions?.["agent-a"].reason).toBe("minimumDwell");
    expect(early.agents[0].state).toBe("joined");
    expect(early.agents[0].joinedGroupId).toBe("group-a");
    expect(early.groupCandidates[0].memberIds).toContain("agent-a");
    expect(early.agents[0].clusterDepartureCount ?? 0).toBe(0);

    const laterBase = makeState({
      ...base,
      tick: 30,
      agents: [{ ...joined, currentEpisode: { ...joined.currentEpisode!, lastUpdatedTick: 30 } }],
    });
    const later = step(laterBase, enabled);
    const decision = later.venueRuntimeState?.lastDecisions?.["agent-a"];
    expect(decision?.reason).toBe("selectedDrink");
    expect(decision?.action).toBe("startDrinkVisit");
    expect(later.agents[0].state).toBe("joined");
    expect(later.agents[0].joinedGroupId).toBe("group-a");
    expect(later.groupCandidates[0].memberIds).toContain("agent-a");
    expect(later.agents[0].clusterDepartureCount ?? 0).toBe(0);
    expect(later.log.some((entry) => entry.eventType === "clusterDepartureStarted")).toBe(false);
    expect(later.venueRuntimeState?.visits["agent-a"]).toBeUndefined();

    const off = step({ ...laterBase, venueRuntimeState: undefined }, disabled, new SeededRandom(1));
    const onAgain = step(laterBase, enabled, new SeededRandom(1));
    expect(withoutVenue(onAgain)).toEqual(withoutVenue(off));
  });

  it("社会的移動意図を飲食needで消さず、進行中訪問は選び直さない", () => {
    const pending = {
      targetClusterId: "group-far",
      sourceClusterId: "group-old",
      decidedAtTick: 1,
      expiresAtTick: 80,
      interestScore: 0.8,
      primaryReason: "alternativeClusterInterest" as const,
    };
    const person = makeAgent({
      x: 80,
      y: 80,
      willingness: 0,
      conformity: 0,
      pendingClusterTransition: pending,
    });
    const far: GroupCandidate = {
      id: "group-far",
      x: 720,
      y: 420,
      memberIds: ["ghost-1"],
      status: "confirmed",
      age: 5,
      everConfirmed: true,
    };
    const source: GroupCandidate = {
      id: "group-old",
      x: 200,
      y: 200,
      memberIds: ["ghost-2", "ghost-3", "ghost-4"],
      status: "confirmed",
      age: 5,
      everConfirmed: true,
    };
    const state = makeState({
      agents: [person],
      groupCandidates: [source, far],
      standingPartyConfig: enabled.standingPartyConfig,
      venueRuntimeState: {
        needs: { "agent-a": { hunger: 1, thirst: 1, hungerRate: 1, thirstRate: 1 } },
        visits: {},
      },
    });
    const next = step(state, enabled);
    expect(next.agents[0].pendingClusterTransition).toEqual(pending);
    expect(next.venueRuntimeState?.visits["agent-a"]).toBeUndefined();
    expect(["pendingSocialTransition", "notEligibleState"]).toContain(
      next.venueRuntimeState?.lastDecisions?.["agent-a"].reason,
    );
    expect(next.venueRuntimeState?.lastDecisions?.["agent-a"].action).not.toMatch(/^start/);

    const visit: PendingVenueVisit = {
      visitId: "agent-a:anchor:food-main:2",
      anchorId: MVP_FOOD_ANCHOR.id,
      purpose: "food",
      startedAtTick: 2,
      phase: "traveling",
      phaseEnteredAtTick: 2,
      decisionReason: "selectedFood",
    };
    const visiting = makeState({
      agents: [makeAgent({ pendingClusterTransition: undefined })],
      standingPartyConfig: enabled.standingPartyConfig,
      venueRuntimeState: {
        needs: { "agent-a": { hunger: 0.1, thirst: 1, hungerRate: 1, thirstRate: 1 } },
        visits: { "agent-a": visit },
      },
    });
    const kept = step(visiting, enabled);
    expect(kept.venueRuntimeState?.visits["agent-a"]).toEqual(visit);
    expect(kept.venueRuntimeState?.lastDecisions?.["agent-a"]).toMatchObject({
      action: "keepCurrentVisit",
      reason: "activeVenueVisit",
      anchorId: MVP_FOOD_ANCHOR.id,
    });
  });

  it("leftのneedは増えず、Inspectorは保存済みdecisionを再計算せずに読める", () => {
    const state = makeState({
      agents: [makeAgent({ state: "left", isObserverJoiner: true })],
      standingPartyConfig: enabled.standingPartyConfig,
      venueRuntimeState: {
        needs: { "agent-a": { hunger: 0.42, thirst: 0.24, hungerRate: 1, thirstRate: 1.1 } },
        visits: {},
        lastDecisions: {
          "agent-a": {
            action: "continueExploration",
            reason: "belowThreshold",
            hunger: 0.42,
            thirst: 0.24,
          },
        },
      },
    });
    const next = step(state, enabled);
    expect(next.venueRuntimeState?.needs["agent-a"].hunger).toBe(0.42);
    expect(next.venueRuntimeState?.needs["agent-a"].thirst).toBe(0.24);
    expect(next.venueRuntimeState?.lastDecisions?.["agent-a"].reason).toBe("notEligibleState");

    const readout = readVenueAgentReadout(state.venueRuntimeState, "agent-a");
    expect(readout).toMatchObject({
      hunger: 0.42,
      thirst: 0.24,
      reason: "belowThreshold",
    });
    const [inspection] = buildAgentInspection(state, DEFAULT_PARAMS);
    expect(inspection.venueVisit).toEqual(readout);
    expect(buildAgentInspection({ ...state, venueRuntimeState: undefined }, DEFAULT_PARAMS)[0].venueVisit).toBeUndefined();
  });

  it("標準係数の数百tickの実行で、複数agentにfoodまたはdrinkの訪問意図が出る", () => {
    const preset = getPresetById("standing-party");
    const rng = new SeededRandom(7);
    let state = createInitialState(7, preset.params, undefined, undefined, undefined, undefined, undefined, enabled);
    const starters = new Set<string>();
    for (let i = 0; i < 220; i++) {
      state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, enabled);
      for (const [agentId, decision] of Object.entries(state.venueRuntimeState?.lastDecisions ?? {})) {
        if (decision.reason === "selectedFood" || decision.reason === "selectedDrink") starters.add(agentId);
      }
    }
    expect(starters.size).toBeGreaterThanOrEqual(2);
    expect(state.venueRuntimeState?.visits).toEqual({});
    expect(state.log.some((entry) => String(entry.eventType).startsWith("venue"))).toBe(false);
  });
});
