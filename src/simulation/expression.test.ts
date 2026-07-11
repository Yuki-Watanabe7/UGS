import { describe, expect, it } from "vitest";
import { deriveExpressionEvents } from "./expression";
import type { ExpressionEvent } from "./expression";
import type { Agent, GroupCandidate, SimulationState } from "./types";

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
    tick: 1,
    agents: [],
    groupCandidates: [],
    log: [],
    width: 800,
    height: 520,
    finished: false,
    ...overrides,
  };
}

const CONTEXT = { seed: 42 };

describe("deriveExpressionEvents: purity and boundaries", () => {
  it("does not mutate previousState or nextState", () => {
    const previous = makeState({ tick: 4, agents: [makeAgent({ state: "undecided" })] });
    const next = makeState({ tick: 5, agents: [makeAgent({ state: "forming", initiative: 0.7 })] });
    const previousSnapshot = JSON.parse(JSON.stringify(previous));
    const nextSnapshot = JSON.parse(JSON.stringify(next));

    deriveExpressionEvents(previous, next, CONTEXT);

    expect(previous).toEqual(previousSnapshot);
    expect(next).toEqual(nextSnapshot);
  });

  it("returns no events when no agent changed state or invitedAtTick", () => {
    const agent = makeAgent({ state: "undecided" });
    const previous = makeState({ tick: 4, agents: [agent] });
    const next = makeState({ tick: 5, agents: [{ ...agent }] });

    expect(deriveExpressionEvents(previous, next, CONTEXT)).toEqual([]);
  });

  it("is deterministic across repeated calls with the same inputs", () => {
    const previous = makeState({ tick: 4, agents: [makeAgent({ state: "undecided" })] });
    const next = makeState({ tick: 5, agents: [makeAgent({ state: "forming", initiative: 0.7 })] });

    const first = deriveExpressionEvents(previous, next, CONTEXT);
    const second = deriveExpressionEvents(previous, next, CONTEXT);

    expect(first).toEqual(second);
  });

  it("ignores agents present in nextState but absent from previousState", () => {
    const previous = makeState({ tick: 4, agents: [] });
    const next = makeState({ tick: 5, agents: [makeAgent({ id: "agent-new", state: "forming" })] });

    expect(deriveExpressionEvents(previous, next, CONTEXT)).toEqual([]);
  });
});

describe("deriveExpressionEvents: kind is restricted to thought in Phase 1", () => {
  it("never produces a 'speech' kind event", () => {
    const agents: Agent[] = [
      makeAgent({ id: "a", state: "undecided" }),
      makeAgent({ id: "b", state: "undecided" }),
      makeAgent({ id: "c", state: "leaving" }),
    ];
    const nextAgents: Agent[] = [
      makeAgent({ id: "a", state: "forming", initiative: 0.8 }),
      makeAgent({ id: "b", state: "leaving" }),
      makeAgent({ id: "c", state: "left" }),
    ];
    const previous = makeState({ tick: 4, agents });
    const next = makeState({ tick: 5, agents: nextAgents });

    const events = deriveExpressionEvents(previous, next, CONTEXT);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.kind === "thought")).toBe(true);
  });
});

describe("deriveExpressionEvents: state transition mapping", () => {
  it("derives 'initiativeFormedCore' when a high-initiative agent starts forming", () => {
    const previous = makeState({ tick: 4, agents: [makeAgent({ state: "undecided", initiative: 0.8 })] });
    const next = makeState({ tick: 5, agents: [makeAgent({ state: "forming", initiative: 0.8 })] });

    const [event] = deriveExpressionEvents(previous, next, CONTEXT);
    expect(event.intent).toBe("consideringJoining");
    expect(event.reason).toBe("initiativeFormedCore");
    expect(event.tick).toBe(5);
    expect(event.agentId).toBe("agent-x");
  });

  it("derives 'cliqueFormedCore' when a low-initiative agent starts forming via a clique", () => {
    const previous = makeState({ tick: 4, agents: [makeAgent({ state: "undecided", initiative: 0.2 })] });
    const next = makeState({ tick: 5, agents: [makeAgent({ state: "forming", initiative: 0.2 })] });

    const [event] = deriveExpressionEvents(previous, next, CONTEXT);
    expect(event.reason).toBe("cliqueFormedCore");
  });

  it("distinguishes approaching a forming vs. confirmed candidate", () => {
    const candidate: GroupCandidate = {
      id: "group-1",
      x: 400,
      y: 260,
      memberIds: [],
      status: "confirmed",
      age: 0,
    };
    const previous = makeState({ tick: 4, agents: [makeAgent({ state: "undecided" })] });
    const next = makeState({
      tick: 5,
      agents: [makeAgent({ state: "approaching", joinedGroupId: "group-1" })],
      groupCandidates: [candidate],
    });

    const [event] = deriveExpressionEvents(previous, next, CONTEXT);
    expect(event.intent).toBe("approachingGroup");
    expect(event.reason).toBe("approachedConfirmedGroup");
  });

  it("marks observerJoiner giving up as 'ambiguityStressExceeded' with higher priority", () => {
    const previous = makeState({ tick: 4, agents: [makeAgent({ state: "undecided", isObserverJoiner: true })] });
    const next = makeState({ tick: 5, agents: [makeAgent({ state: "leaving", isObserverJoiner: true })] });

    const [event] = deriveExpressionEvents(previous, next, CONTEXT);
    expect(event.intent).toBe("givingUpWaiting");
    expect(event.reason).toBe("ambiguityStressExceeded");
    expect(event.priority).toBeGreaterThan(1);
    expect(event.recommendedTtlTicks).toBeGreaterThan(0);
  });

  it("derives 'reachedScreenEdge' when a leaving agent finally leaves", () => {
    const previous = makeState({ tick: 4, agents: [makeAgent({ state: "leaving" })] });
    const next = makeState({ tick: 5, agents: [makeAgent({ state: "left" })] });

    const [event] = deriveExpressionEvents(previous, next, CONTEXT);
    expect(event.intent).toBe("leftEvent");
    expect(event.reason).toBe("reachedScreenEdge");
  });

  it("derives 'noticedInvitation' when invitedAtTick newly becomes set, independent of state change", () => {
    const previous = makeState({
      tick: 4,
      agents: [makeAgent({ state: "undecided", isObserverJoiner: true, invitedAtTick: undefined })],
    });
    const next = makeState({
      tick: 5,
      agents: [makeAgent({ state: "undecided", isObserverJoiner: true, invitedAtTick: 5 })],
    });

    const [event] = deriveExpressionEvents(previous, next, CONTEXT);
    expect(event.intent).toBe("noticedInvitation");
    expect(event.reason).toBe("receivedLightInvitation");
  });

  it("assigns a stable, unique id per (tick, agent, intent)", () => {
    const previous = makeState({ tick: 4, agents: [makeAgent({ state: "undecided", initiative: 0.8 })] });
    const next = makeState({ tick: 5, agents: [makeAgent({ state: "forming", initiative: 0.8 })] });

    const [event]: ExpressionEvent[] = deriveExpressionEvents(previous, next, CONTEXT);
    expect(event.id).toBe("expr-5-agent-x-consideringJoining");
  });

  it("uses a textKey template reference rather than literal display text", () => {
    const previous = makeState({ tick: 4, agents: [makeAgent({ state: "undecided", initiative: 0.8 })] });
    const next = makeState({ tick: 5, agents: [makeAgent({ state: "forming", initiative: 0.8 })] });

    const [event] = deriveExpressionEvents(previous, next, CONTEXT);
    expect(event.textKey).toMatch(/^thought\.initiativeFormedCore\.v\d$/);
  });
});

describe("deriveExpressionEvents: does not depend on the main PRNG", () => {
  it("produces identical output for different seeds only in the textKey variant, not in intent/reason", () => {
    const previous = makeState({ tick: 4, agents: [makeAgent({ state: "undecided", initiative: 0.8 })] });
    const next = makeState({ tick: 5, agents: [makeAgent({ state: "forming", initiative: 0.8 })] });

    const a = deriveExpressionEvents(previous, next, { seed: 1 });
    const b = deriveExpressionEvents(previous, next, { seed: 2 });

    expect(a[0].intent).toBe(b[0].intent);
    expect(a[0].reason).toBe(b[0].reason);
  });
});

describe("deriveExpressionEvents: stress threshold crossings (undecided-only, no state transition)", () => {
  it("derives 'stressRising' only on the tick where stress/leaveThreshold first crosses 0.5", () => {
    const previous = makeState({
      tick: 4,
      agents: [makeAgent({ state: "undecided", stress: 0.4, leaveThreshold: 1 })],
    });
    const next = makeState({
      tick: 5,
      agents: [makeAgent({ state: "undecided", stress: 0.55, leaveThreshold: 1 })],
    });

    const events = deriveExpressionEvents(previous, next, CONTEXT);
    expect(events).toHaveLength(1);
    expect(events[0].intent).toBe("stressRising");
    expect(events[0].reason).toBe("stressCrossedRisingThreshold");
  });

  it("does not repeat 'stressRising' once already above the threshold", () => {
    const previous = makeState({
      tick: 5,
      agents: [makeAgent({ state: "undecided", stress: 0.55, leaveThreshold: 1 })],
    });
    const next = makeState({
      tick: 6,
      agents: [makeAgent({ state: "undecided", stress: 0.6, leaveThreshold: 1 })],
    });

    const events = deriveExpressionEvents(previous, next, CONTEXT);
    expect(events.filter((e) => e.intent === "stressRising")).toHaveLength(0);
  });

  it("derives 'consideringLeaving' only on the tick where stress/leaveThreshold first crosses 0.85", () => {
    const previous = makeState({
      tick: 4,
      agents: [makeAgent({ state: "undecided", stress: 0.8, leaveThreshold: 1 })],
    });
    const next = makeState({
      tick: 5,
      agents: [makeAgent({ state: "undecided", stress: 0.9, leaveThreshold: 1 })],
    });

    const events = deriveExpressionEvents(previous, next, CONTEXT);
    expect(events).toHaveLength(1);
    expect(events[0].intent).toBe("consideringLeaving");
    expect(events[0].reason).toBe("stressNearLeaveThreshold");
  });

  it("derives both 'stressRising' and 'consideringLeaving' when a single tick crosses both thresholds", () => {
    const previous = makeState({
      tick: 4,
      agents: [makeAgent({ state: "undecided", stress: 0.3, leaveThreshold: 1 })],
    });
    const next = makeState({
      tick: 5,
      agents: [makeAgent({ state: "undecided", stress: 0.95, leaveThreshold: 1 })],
    });

    const events = deriveExpressionEvents(previous, next, CONTEXT);
    const intents = events.map((e) => e.intent).sort();
    expect(intents).toEqual(["consideringLeaving", "stressRising"].sort());
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });

  it("does not derive stress-threshold events when the agent transitions out of 'undecided' this tick", () => {
    const previous = makeState({
      tick: 4,
      agents: [makeAgent({ state: "undecided", stress: 0.95, leaveThreshold: 1 })],
    });
    const next = makeState({
      tick: 5,
      agents: [makeAgent({ state: "leaving", stress: 0.95, leaveThreshold: 1 })],
    });

    const events = deriveExpressionEvents(previous, next, CONTEXT);
    expect(events.map((e) => e.intent)).toEqual(["givingUpWaiting"]);
  });
});

describe("deriveExpressionEvents: hesitating/watching cooldown for persistent undecided conditions", () => {
  it("derives 'hesitating' (not 'watching') when a joinable candidate exists nearby, on a cooldown cadence rather than every tick", () => {
    const candidate: GroupCandidate = {
      id: "group-1",
      x: 450,
      y: 260,
      memberIds: [],
      status: "forming",
      age: 0,
    };
    let fired = 0;
    for (let tick = 1; tick <= 16; tick++) {
      const previous = makeState({ tick: tick - 1, agents: [makeAgent({ state: "undecided" })] });
      const next = makeState({
        tick,
        agents: [makeAgent({ state: "undecided" })],
        groupCandidates: [candidate],
      });
      const events = deriveExpressionEvents(previous, next, CONTEXT);
      const hesitationEvents = events.filter((e) => e.intent === "hesitating");
      const watchingEvents = events.filter((e) => e.intent === "watching");
      expect(watchingEvents).toHaveLength(0);
      fired += hesitationEvents.length;
      for (const e of hesitationEvents) {
        expect(e.reason).toBe("nearbyGroupUnapproached");
      }
    }
    // 16 ticks / 8-tick cooldown period = exactly 2 firings, not 16
    expect(fired).toBe(2);
  });

  it("derives 'watching' (not 'hesitating') when no joinable candidate exists nearby", () => {
    let fired = 0;
    for (let tick = 1; tick <= 16; tick++) {
      const previous = makeState({ tick: tick - 1, agents: [makeAgent({ state: "undecided" })] });
      const next = makeState({ tick, agents: [makeAgent({ state: "undecided" })], groupCandidates: [] });
      const events = deriveExpressionEvents(previous, next, CONTEXT);
      const watchingEvents = events.filter((e) => e.intent === "watching");
      expect(events.filter((e) => e.intent === "hesitating")).toHaveLength(0);
      fired += watchingEvents.length;
      for (const e of watchingEvents) {
        expect(e.reason).toBe("noJoinableGroupNearby");
      }
    }
    expect(fired).toBe(2);
  });

  it("treats a dissolved/expired candidate as no candidate (derives 'watching', not 'hesitating')", () => {
    const candidate: GroupCandidate = {
      id: "group-1",
      x: 450,
      y: 260,
      memberIds: [],
      status: "dissolved",
      age: 1,
    };
    let sawWatching = false;
    for (let tick = 1; tick <= 16; tick++) {
      const previous = makeState({ tick: tick - 1, agents: [makeAgent({ state: "undecided" })] });
      const next = makeState({
        tick,
        agents: [makeAgent({ state: "undecided" })],
        groupCandidates: [candidate],
      });
      const events = deriveExpressionEvents(previous, next, CONTEXT);
      if (events.some((e) => e.intent === "watching")) sawWatching = true;
      expect(events.filter((e) => e.intent === "hesitating")).toHaveLength(0);
    }
    expect(sawWatching).toBe(true);
  });
});
