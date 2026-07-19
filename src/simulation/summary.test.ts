import { describe, expect, it } from "vitest";
import { buildSimulationSummary, buildSpeechEffectsRunSummary } from "./summary";
import type { Agent, LogEntry, SimulationState } from "./types";
import type { SpeechEffectEvent, SpeechInterpretationEvent, SpeechReceptionEvent } from "./speechEffects";

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

function makeState(overrides: Partial<SimulationState>): SimulationState {
  return {
    tick: 0,
    agents: [],
    groupCandidates: [],
    log: [],
    width: 800,
    height: 520,
    finished: false,
    ...overrides,
  };
}

describe("buildSimulationSummary: stateCounts / joinedCount / leftCount", () => {
  it("aggregates state counts and joined/left counts from state.agents", () => {
    const agents: Agent[] = [
      makeAgent({ id: "a", state: "joined" }),
      makeAgent({ id: "b", state: "joined" }),
      makeAgent({ id: "c", state: "left" }),
      makeAgent({ id: "d", state: "undecided" }),
      makeAgent({ id: "e", state: "leaving" }),
      makeAgent({ id: "f", state: "unassigned" }),
    ];
    const state = makeState({ agents });

    const summary = buildSimulationSummary(state);

    expect(summary.joinedCount).toBe(2);
    expect(summary.leftCount).toBe(1);
    expect(summary.unassignedCount).toBe(1);
    expect(summary.stateCounts).toEqual({
      undecided: 1,
      forming: 0,
      approaching: 0,
      joined: 2,
      leaving: 1,
      left: 1,
      unassigned: 1,
    });
  });
});

describe("buildSimulationSummary: classroom unassigned / finish reason (Issue #134)", () => {
  it("lists unassigned agents with their structured search snapshots and finish reason", () => {
    const unassigned = makeAgent({
      id: "unassigned-1",
      label: "U",
      state: "unassigned",
      stress: 0.8,
      searchRestartCount: 3,
      capacityFailureCount: 2,
      lastFailedCandidateId: "pair-old",
    });
    const log: LogEntry[] = [
      {
        tick: 20,
        message: "",
        tags: ["unassigned"],
        eventType: "agentUnassigned",
        metadata: {
          agentId: "unassigned-1",
          groupId: "pair-target",
          previousAgentState: "approaching",
          searchRestartCount: 3,
          capacityFailureCount: 2,
          lastFailedCandidateId: "pair-old",
          stress: 0.8,
        },
      },
      {
        tick: 20,
        message: "",
        tags: ["simulation"],
        eventType: "simulationFinished",
        metadata: { assignedCount: 2, unassignedCount: 1, finishReason: "deadlineReached" },
      },
    ];
    const state = makeState({ agents: [unassigned], log, tick: 20, finished: true });

    const summary = buildSimulationSummary(state);

    expect(summary.finishReason).toBe("deadlineReached");
    expect(summary.unassignedCount).toBe(1);
    expect(summary.unassignedAgents).toEqual([
      {
        agentId: "unassigned-1",
        label: "U",
        previousState: "approaching",
        targetGroupId: "pair-target",
        searchRestartCount: 3,
        capacityFailureCount: 2,
        lastFailedCandidateId: "pair-old",
        stress: 0.8,
      },
    ]);
  });
});

describe("buildSimulationSummary: observerJoiners", () => {
  it("extracts final state and structured-event ticks for an observerJoiner", () => {
    const observer = makeAgent({
      id: "observer-1",
      label: "Observer",
      isObserverJoiner: true,
      state: "leaving",
    });
    const log: LogEntry[] = [
      { tick: 3, message: "", tags: [], eventType: "observerApproached", metadata: { agentId: "observer-1" } },
      {
        tick: 5,
        message: "",
        tags: [],
        eventType: "observerJoinedForming",
        metadata: { agentId: "observer-1", joinedGroupStatus: "forming" },
      },
      { tick: 20, message: "", tags: [], eventType: "observerLeaveStarted", metadata: { agentId: "observer-1" } },
    ];
    const state = makeState({ agents: [observer], log });

    const [summary] = buildSimulationSummary(state).observerJoiners;

    expect(summary.agentId).toBe("observer-1");
    expect(summary.label).toBe("Observer");
    expect(summary.finalState).toBe("leaving");
    expect(summary.approachedTick).toBe(3);
    expect(summary.joinedTick).toBe(5);
    expect(summary.joinedGroupStatus).toBe("forming");
    expect(summary.leaveStartedTick).toBe(20);
    expect(summary.leftTick).toBeUndefined();
  });

  it("returns one entry per observerJoiner, in agent order, and none for non-observers", () => {
    const state = makeState({
      agents: [
        makeAgent({ id: "plain", isObserverJoiner: false }),
        makeAgent({ id: "observer-a", isObserverJoiner: true }),
        makeAgent({ id: "observer-b", isObserverJoiner: true }),
      ],
    });

    const { observerJoiners } = buildSimulationSummary(state);

    expect(observerJoiners.map((o) => o.agentId)).toEqual(["observer-a", "observer-b"]);
  });
});

describe("buildSimulationSummary: lateJoinSucceeded", () => {
  it("is true when the observerJoiner joined an already-confirmed group", () => {
    const observer = makeAgent({ id: "observer-1", isObserverJoiner: true, state: "joined" });
    const log: LogEntry[] = [
      {
        tick: 10,
        message: "",
        tags: [],
        eventType: "observerJoinedConfirmed",
        metadata: { agentId: "observer-1", joinedGroupStatus: "confirmed" },
      },
    ];
    const state = makeState({ agents: [observer], log });

    const [summary] = buildSimulationSummary(state).observerJoiners;

    expect(summary.lateJoinSucceeded).toBe(true);
  });

  it("is true when the observerJoiner joined a forming group after some group had already been confirmed elsewhere", () => {
    const observer = makeAgent({ id: "observer-1", isObserverJoiner: true, state: "joined" });
    const log: LogEntry[] = [
      { tick: 5, message: "", tags: [], eventType: "groupConfirmed", metadata: { groupId: "other-group" } },
      {
        tick: 8,
        message: "",
        tags: [],
        eventType: "observerJoinedForming",
        metadata: { agentId: "observer-1", joinedGroupStatus: "forming" },
      },
    ];
    const state = makeState({ agents: [observer], log });

    const [summary] = buildSimulationSummary(state).observerJoiners;

    expect(summary.lateJoinSucceeded).toBe(true);
  });

  it("is false when the observerJoiner joined a forming group before any group had confirmed", () => {
    const observer = makeAgent({ id: "observer-1", isObserverJoiner: true, state: "joined" });
    const log: LogEntry[] = [
      {
        tick: 8,
        message: "",
        tags: [],
        eventType: "observerJoinedForming",
        metadata: { agentId: "observer-1", joinedGroupStatus: "forming" },
      },
      { tick: 12, message: "", tags: [], eventType: "groupConfirmed", metadata: { groupId: "own-group" } },
    ];
    const state = makeState({ agents: [observer], log });

    const [summary] = buildSimulationSummary(state).observerJoiners;

    expect(summary.lateJoinSucceeded).toBe(false);
  });

  it("is false when the observerJoiner never joined", () => {
    const observer = makeAgent({ id: "observer-1", isObserverJoiner: true, state: "left" });
    const state = makeState({ agents: [observer] });

    const [summary] = buildSimulationSummary(state).observerJoiners;

    expect(summary.lateJoinSucceeded).toBe(false);
  });
});

describe("buildSimulationSummary: nucleus / group confirmation aggregates", () => {
  it("takes the earliest nucleusCreated tick as firstNucleusTick", () => {
    const log: LogEntry[] = [
      { tick: 10, message: "", tags: [], eventType: "nucleusCreated", metadata: { groupId: "g2" } },
      { tick: 4, message: "", tags: [], eventType: "nucleusCreated", metadata: { groupId: "g1" } },
    ];
    const state = makeState({ log });

    expect(buildSimulationSummary(state).firstNucleusTick).toBe(4);
  });

  it("takes the earliest groupConfirmed tick as firstGroupConfirmedTick and counts confirmed groups", () => {
    const log: LogEntry[] = [
      { tick: 15, message: "", tags: [], eventType: "groupConfirmed", metadata: { groupId: "g2" } },
      { tick: 9, message: "", tags: [], eventType: "groupConfirmed", metadata: { groupId: "g1" } },
    ];
    const state = makeState({ log });

    const summary = buildSimulationSummary(state);

    expect(summary.firstGroupConfirmedTick).toBe(9);
    expect(summary.confirmedGroupCount).toBe(2);
    expect(summary.groupFailure).toBe(false);
  });

  it("reports groupFailure: true and undefined tick when no group ever confirmed", () => {
    const summary = buildSimulationSummary(makeState({}));

    expect(summary.groupFailure).toBe(true);
    expect(summary.confirmedGroupCount).toBe(0);
    expect(summary.firstGroupConfirmedTick).toBeUndefined();
  });
});

describe("buildSimulationSummary: finished / provisional", () => {
  it("returns finishedTick from the simulationFinished event when finished", () => {
    const log: LogEntry[] = [{ tick: 42, message: "", tags: [], eventType: "simulationFinished" }];
    const state = makeState({ tick: 42, finished: true, log });

    expect(buildSimulationSummary(state).finished).toBe(true);
    expect(buildSimulationSummary(state).finishedTick).toBe(42);
  });

  it("returns a provisional summary without throwing when the simulation has not finished", () => {
    const state = makeState({ tick: 7, finished: false, agents: [makeAgent({ id: "a", state: "undecided" })] });

    const summary = buildSimulationSummary(state);

    expect(summary.finished).toBe(false);
    expect(summary.finishedTick).toBeUndefined();
    expect(summary.stateCounts.undecided).toBe(1);
  });
});

describe("buildSpeechEffectsRunSummary", () => {
  function makeReception(overrides: Partial<SpeechReceptionEvent>): SpeechReceptionEvent {
    return {
      id: "reception-1",
      speechEventId: "speech-1",
      tick: 1,
      receiverId: "observer-1",
      relation: "audience",
      distance: 10,
      threshold: 100,
      heard: true,
      reason: "withinRange",
      ...overrides,
    };
  }

  function makeInterpretation(overrides: Partial<SpeechInterpretationEvent>): SpeechInterpretationEvent {
    return {
      id: "interpretation-1",
      speechEventId: "speech-1",
      receptionEventId: "reception-1",
      tick: 1,
      receiverId: "observer-1",
      intent: "invite",
      relation: "audience",
      valence: "positive",
      intensity: 0.5,
      factors: [],
      ...overrides,
    };
  }

  function makeEffect(overrides: Partial<SpeechEffectEvent>): SpeechEffectEvent {
    return {
      id: "effect-1",
      speechEventId: "speech-1",
      interpretationEventId: "interpretation-1",
      receiverId: "observer-1",
      speakerId: "founder",
      intent: "invite",
      reason: "initiativeFormedCore",
      occurredTick: 1,
      appliedTick: 1,
      dimension: "approachProbability",
      outputValue: 0.2,
      durationTicks: 5,
      ...overrides,
    };
  }

  it("returns all-false/all-zero when no Phase 3 logs are present (effects disabled)", () => {
    const state = makeState({});

    const summary = buildSpeechEffectsRunSummary(state);

    expect(summary.observerJoinerHeardSpeech).toBe(false);
    expect(summary.hadInterpretationOrEffect).toBe(false);
    expect(summary.transitionInfluenced).toBe(false);
    expect(summary.dimensionTotals).toEqual({
      stress: 0,
      attractiveness: 0,
      approachProbability: 0,
      leaveThreshold: 0,
    });
  });

  it("marks observerJoinerHeardSpeech only when a heard reception targets an observerJoiner", () => {
    const observer = makeAgent({ id: "observer-1", isObserverJoiner: true });
    const notHeard = makeState({
      agents: [observer],
      speechReceptionLog: [makeReception({ heard: false })],
    });
    const heardButNotObserver = makeState({
      agents: [observer],
      speechReceptionLog: [makeReception({ receiverId: "other", heard: true })],
    });
    const heardByObserver = makeState({
      agents: [observer],
      speechReceptionLog: [makeReception({ receiverId: "observer-1", heard: true })],
    });

    expect(buildSpeechEffectsRunSummary(notHeard).observerJoinerHeardSpeech).toBe(false);
    expect(buildSpeechEffectsRunSummary(heardButNotObserver).observerJoinerHeardSpeech).toBe(false);
    expect(buildSpeechEffectsRunSummary(heardByObserver).observerJoinerHeardSpeech).toBe(true);
  });

  it("marks hadInterpretationOrEffect for a non-neutral interpretation even without an effect", () => {
    const state = makeState({
      speechInterpretationLog: [makeInterpretation({ valence: "positive" })],
    });

    expect(buildSpeechEffectsRunSummary(state).hadInterpretationOrEffect).toBe(true);
  });

  it("does not mark hadInterpretationOrEffect for a neutral-only interpretation with no effect", () => {
    const state = makeState({
      speechInterpretationLog: [makeInterpretation({ valence: "neutral" })],
    });

    expect(buildSpeechEffectsRunSummary(state).hadInterpretationOrEffect).toBe(false);
  });

  it("sums the absolute outputValue per dimension across all effects", () => {
    const state = makeState({
      speechEffectLog: [
        makeEffect({ dimension: "approachProbability", outputValue: 0.2 }),
        makeEffect({ id: "effect-2", dimension: "approachProbability", outputValue: -0.1 }),
        makeEffect({ id: "effect-3", dimension: "attractiveness", outputValue: 0.35 }),
      ],
    });

    const { dimensionTotals } = buildSpeechEffectsRunSummary(state);
    expect(dimensionTotals.stress).toBe(0);
    expect(dimensionTotals.leaveThreshold).toBe(0);
    expect(dimensionTotals.attractiveness).toBeCloseTo(0.35);
    expect(dimensionTotals.approachProbability).toBeCloseTo(0.3);
  });

  it("marks transitionInfluenced when a matching structured log event falls within the effect's active window", () => {
    const log: LogEntry[] = [
      { tick: 3, message: "", tags: [], eventType: "observerApproached", metadata: { agentId: "observer-1" } },
    ];
    const state = makeState({
      log,
      speechEffectLog: [
        makeEffect({ receiverId: "observer-1", dimension: "approachProbability", appliedTick: 1, durationTicks: 5 }),
      ],
    });

    expect(buildSpeechEffectsRunSummary(state).transitionInfluenced).toBe(true);
  });

  it("does not mark transitionInfluenced when the matching event falls outside the effect's active window", () => {
    const log: LogEntry[] = [
      { tick: 10, message: "", tags: [], eventType: "observerApproached", metadata: { agentId: "observer-1" } },
    ];
    const state = makeState({
      log,
      speechEffectLog: [
        makeEffect({ receiverId: "observer-1", dimension: "approachProbability", appliedTick: 1, durationTicks: 5 }),
      ],
    });

    expect(buildSpeechEffectsRunSummary(state).transitionInfluenced).toBe(false);
  });

  it("never marks transitionInfluenced for the stress dimension (no discrete transition event is defined for it)", () => {
    const log: LogEntry[] = [
      { tick: 2, message: "", tags: [], eventType: "observerApproached", metadata: { agentId: "observer-1" } },
    ];
    const state = makeState({
      log,
      speechEffectLog: [
        makeEffect({ receiverId: "observer-1", dimension: "stress", intent: "greet", appliedTick: 1, durationTicks: 6 }),
      ],
    });

    expect(buildSpeechEffectsRunSummary(state).transitionInfluenced).toBe(false);
  });

  it("does not mutate the SimulationState passed in", () => {
    const state = makeState({
      speechReceptionLog: [makeReception({})],
      speechInterpretationLog: [makeInterpretation({})],
      speechEffectLog: [makeEffect({})],
    });
    const snapshot = JSON.parse(JSON.stringify(state));

    buildSpeechEffectsRunSummary(state);

    expect(state).toEqual(snapshot);
  });
});

describe("buildSimulationSummary: purity", () => {
  it("does not mutate the SimulationState passed in", () => {
    const observer = makeAgent({ id: "observer-1", isObserverJoiner: true, state: "joined" });
    const log: LogEntry[] = [
      {
        tick: 5,
        message: "",
        tags: [],
        eventType: "observerJoinedConfirmed",
        metadata: { agentId: "observer-1", joinedGroupStatus: "confirmed" },
      },
    ];
    const state = makeState({ agents: [observer], log, tick: 5, finished: true });
    const snapshot = JSON.parse(JSON.stringify(state));

    buildSimulationSummary(state);

    expect(state).toEqual(snapshot);
  });
});
