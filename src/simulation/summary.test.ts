import { describe, expect, it } from "vitest";
import { buildSimulationSummary } from "./summary";
import type { Agent, LogEntry, SimulationState } from "./types";

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
    ];
    const state = makeState({ agents });

    const summary = buildSimulationSummary(state);

    expect(summary.joinedCount).toBe(2);
    expect(summary.leftCount).toBe(1);
    expect(summary.stateCounts).toEqual({
      undecided: 1,
      forming: 0,
      approaching: 0,
      joined: 2,
      leaving: 1,
      left: 1,
    });
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
