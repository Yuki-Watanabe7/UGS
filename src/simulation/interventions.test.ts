import { describe, expect, it } from "vitest";
import {
  applyInterventionParamAdjustments,
  applyLightInvitationEffect,
  getInterventionById,
  INTERVENTION_SCENARIOS,
  isUnderLightInvitationBoost,
  LIGHT_INVITATION_BOOST_WINDOW,
  LIGHT_INVITATION_MIN_TICK,
  LIGHT_INVITATION_STRESS_RATIO,
  resolveAvailableInterventionIds,
  SCHOOL_INTERVENTION_HOOK_ORDER,
  selectInvitationAgent,
  shouldTriggerLightObserverInvitation,
} from "./interventions";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS } from "./presets";
import type { Agent, SimParams } from "./types";

describe("INTERVENTION_SCENARIOS", () => {
  it("has no duplicate ids", () => {
    const ids = INTERVENTION_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes a 'none' scenario", () => {
    const none = INTERVENTION_SCENARIOS.find((s) => s.id === "none");
    expect(none).toBeDefined();
  });

  it("gives every scenario a name, description, and expectedEffect", () => {
    for (const scenario of INTERVENTION_SCENARIOS) {
      expect(scenario.name.length).toBeGreaterThan(0);
      expect(scenario.description.length).toBeGreaterThan(0);
      expect(scenario.expectedEffect.length).toBeGreaterThan(0);
    }
  });

  it("includes the 6 candidate scenarios named in the roadmap issue", () => {
    const ids = INTERVENTION_SCENARIOS.map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "explicit-meeting-point",
        "late-join-ok",
        "light-observer-invitation",
        "short-ambiguity-window",
        "predecided-venue",
        "anonymous-low-pressure-intent",
      ]),
    );
  });
});

describe("InterventionScenario.applicability (Issue #156)", () => {
  it("gives every scenario applicability metadata", () => {
    for (const scenario of INTERVENTION_SCENARIOS) {
      expect(scenario.applicability.scenarios.length).toBeGreaterThan(0);
      expect(scenario.applicability.audience).toBeDefined();
      expect(Array.isArray(scenario.applicability.hooks)).toBe(true);
      expect(Array.isArray(scenario.applicability.configKeys)).toBe(true);
      expect(typeof scenario.applicability.implemented).toBe("boolean");
    }
  });

  it("marks 'none' as applicable to every FormationScenarioId", () => {
    const none = getInterventionById("none");
    expect(none.applicability.scenarios).toEqual(expect.arrayContaining(["afterParty", "classroomPair"]));
    expect(none.applicability.audience).toBe("none");
  });

  it("marks every non-'none' scenario today as afterParty-only", () => {
    for (const scenario of INTERVENTION_SCENARIOS) {
      if (scenario.id === "none") continue;
      expect(scenario.applicability.scenarios).toEqual(["afterParty"]);
      expect(scenario.applicability.audience).toBe("afterParty");
      expect(scenario.applicability.implemented).toBe(true);
    }
  });

  it("gives afterParty-audience scenarios no school intervention hooks", () => {
    for (const scenario of INTERVENTION_SCENARIOS) {
      if (scenario.applicability.audience === "afterParty") {
        expect(scenario.applicability.hooks).toEqual([]);
      }
    }
  });
});

describe("SCHOOL_INTERVENTION_HOOK_ORDER", () => {
  it("has no duplicates and covers all 6 hooks named in the roadmap issue", () => {
    expect(new Set(SCHOOL_INTERVENTION_HOOK_ORDER).size).toBe(SCHOOL_INTERVENTION_HOOK_ORDER.length);
    expect(SCHOOL_INTERVENTION_HOOK_ORDER).toEqual([
      "initialState",
      "beforeTick",
      "beforeApproachDecision",
      "afterStateTransition",
      "beforeDeadline",
      "atDeadline",
    ]);
  });
});

describe("resolveAvailableInterventionIds (Issue #156)", () => {
  it("returns every implemented afterParty intervention (plus 'none') for the afterParty scenario", () => {
    const ids = resolveAvailableInterventionIds("afterParty");
    expect(ids).toEqual([
      "none",
      "explicit-meeting-point",
      "late-join-ok",
      "light-observer-invitation",
      "short-ambiguity-window",
      "predecided-venue",
      "anonymous-low-pressure-intent",
    ]);
  });

  it("returns only 'none' for the classroomPair scenario (no school interventions implemented yet)", () => {
    expect(resolveAvailableInterventionIds("classroomPair")).toEqual(["none"]);
  });

  it("never returns an afterParty-only intervention for classroomPair", () => {
    const ids = resolveAvailableInterventionIds("classroomPair");
    for (const scenario of INTERVENTION_SCENARIOS) {
      if (scenario.applicability.audience === "afterParty") {
        expect(ids).not.toContain(scenario.id);
      }
    }
  });
});

describe("getInterventionById", () => {
  it("returns the matching scenario", () => {
    expect(getInterventionById("late-join-ok").id).toBe("late-join-ok");
  });

  it("falls back to 'none' for an unknown id", () => {
    expect(getInterventionById("unknown-id" as never).id).toBe("none");
  });
});

describe("applyInterventionParamAdjustments", () => {
  it("does not mutate the input params", () => {
    const params: SimParams = { ...DEFAULT_PARAMS };
    const snapshot = { ...params };
    const intervention = getInterventionById("late-join-ok");

    applyInterventionParamAdjustments(params, intervention);

    expect(params).toEqual(snapshot);
  });

  it("returns params unchanged (by value) for the 'none' intervention", () => {
    const result = applyInterventionParamAdjustments(DEFAULT_PARAMS, getInterventionById("none"));
    expect(result).toEqual(DEFAULT_PARAMS);
  });

  it("applies additive adjustments on top of the given params", () => {
    const result = applyInterventionParamAdjustments(DEFAULT_PARAMS, getInterventionById("late-join-ok"));
    expect(result.lateJoinEase).toBeCloseTo(DEFAULT_PARAMS.lateJoinEase + 0.3);
  });

  it("clamps unit-range fields to [0, 1] after adjustment", () => {
    const nearMax: SimParams = { ...DEFAULT_PARAMS, lateJoinEase: 0.95 };
    const result = applyInterventionParamAdjustments(nearMax, getInterventionById("late-join-ok"));
    expect(result.lateJoinEase).toBe(1);
  });
});

describe("light-observer-invitation", () => {
  const baseObserver: Agent = {
    id: "observer",
    label: "Observer",
    x: 400,
    y: 260,
    vx: 0,
    vy: 0,
    willingness: 0.8,
    initiative: 0.1,
    ambiguityTolerance: 0.5,
    influenceAvoidance: 0.6,
    conformity: 0.5,
    leaveThreshold: 0.6,
    isObserverJoiner: true,
    state: "undecided",
    stress: 0,
  };

  describe("shouldTriggerLightObserverInvitation", () => {
    it("is false before LIGHT_INVITATION_MIN_TICK has elapsed", () => {
      expect(
        shouldTriggerLightObserverInvitation({ ...baseObserver, stress: 0.3 }, LIGHT_INVITATION_MIN_TICK - 1),
      ).toBe(false);
    });

    it("is false when stress is below the trigger ratio of leaveThreshold", () => {
      const stress = baseObserver.leaveThreshold * LIGHT_INVITATION_STRESS_RATIO - 0.01;
      expect(shouldTriggerLightObserverInvitation({ ...baseObserver, stress }, LIGHT_INVITATION_MIN_TICK)).toBe(
        false,
      );
    });

    it("is false once stress has already reached leaveThreshold (too late to help)", () => {
      expect(
        shouldTriggerLightObserverInvitation(
          { ...baseObserver, stress: baseObserver.leaveThreshold },
          LIGHT_INVITATION_MIN_TICK,
        ),
      ).toBe(false);
    });

    it("is false for a non-observerJoiner agent", () => {
      expect(
        shouldTriggerLightObserverInvitation(
          { ...baseObserver, isObserverJoiner: false, stress: 0.4 },
          LIGHT_INVITATION_MIN_TICK,
        ),
      ).toBe(false);
    });

    it("is false once the agent has already been invited", () => {
      expect(
        shouldTriggerLightObserverInvitation(
          { ...baseObserver, stress: 0.4, invitedAtTick: 3 },
          LIGHT_INVITATION_MIN_TICK,
        ),
      ).toBe(false);
    });

    it("is true once the tick/stress conditions are met and the agent hasn't been invited yet", () => {
      expect(shouldTriggerLightObserverInvitation({ ...baseObserver, stress: 0.4 }, LIGHT_INVITATION_MIN_TICK)).toBe(
        true,
      );
    });
  });

  describe("selectInvitationAgent", () => {
    it("picks among nearby engaged agents reproducibly for a fixed seed", () => {
      const nearbyA: Agent = { ...baseObserver, id: "a", isObserverJoiner: false, state: "joined", x: 410, y: 260 };
      const nearbyB: Agent = { ...baseObserver, id: "b", isObserverJoiner: false, state: "forming", x: 390, y: 250 };
      const agents = [baseObserver, nearbyA, nearbyB];

      const first = selectInvitationAgent(baseObserver, agents, new SeededRandom(7));
      const second = selectInvitationAgent(baseObserver, agents, new SeededRandom(7));

      expect(first?.id).toBe(second?.id);
      expect(["a", "b"]).toContain(first?.id);
    });

    it("falls back to the nearest non-observerJoiner agent when no one nearby is engaged", () => {
      const far: Agent = { ...baseObserver, id: "far", isObserverJoiner: false, state: "undecided", x: 700, y: 500 };
      const closer: Agent = {
        ...baseObserver,
        id: "closer",
        isObserverJoiner: false,
        state: "undecided",
        x: 500,
        y: 300,
      };

      const picked = selectInvitationAgent(baseObserver, [baseObserver, far, closer], new SeededRandom(1));
      expect(picked?.id).toBe("closer");
    });

    it("excludes agents who have already left from the fallback", () => {
      const left: Agent = { ...baseObserver, id: "left", isObserverJoiner: false, state: "left", x: 410, y: 260 };
      expect(selectInvitationAgent(baseObserver, [baseObserver, left], new SeededRandom(1))).toBeUndefined();
    });

    it("returns undefined when no other agent exists", () => {
      expect(selectInvitationAgent(baseObserver, [baseObserver], new SeededRandom(1))).toBeUndefined();
    });
  });

  describe("applyLightInvitationEffect / isUnderLightInvitationBoost", () => {
    it("records the invitation tick without mutating unrelated fields", () => {
      const agent = { ...baseObserver };
      applyLightInvitationEffect(agent, 12);
      expect(agent.invitedAtTick).toBe(12);
      expect(agent.stress).toBe(baseObserver.stress);
    });

    it("is under boost only within LIGHT_INVITATION_BOOST_WINDOW ticks of the invitation", () => {
      const agent = { ...baseObserver, invitedAtTick: 10 };
      expect(isUnderLightInvitationBoost(agent, 10)).toBe(true);
      expect(isUnderLightInvitationBoost(agent, 10 + LIGHT_INVITATION_BOOST_WINDOW - 1)).toBe(true);
      expect(isUnderLightInvitationBoost(agent, 10 + LIGHT_INVITATION_BOOST_WINDOW)).toBe(false);
    });

    it("is false when the agent has never been invited", () => {
      expect(isUnderLightInvitationBoost(baseObserver, 999)).toBe(false);
    });
  });
});
