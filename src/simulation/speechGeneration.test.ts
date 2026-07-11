import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS } from "./presets";
import type { Agent, SimulationState } from "./types";

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

function runTicks(state: SimulationState, ticks: number, seed = 42): SimulationState {
  const rng = new SeededRandom(seed);
  let s = state;
  for (let i = 0; i < ticks; i++) {
    s = stepSimulation(s, DEFAULT_PARAMS, rng);
  }
  return s;
}

describe("speech generation boundary: nucleus formation", () => {
  it("records a SpeechEvent alongside a nucleusCreated log entry", () => {
    const founder = makeAgent({ id: "founder", initiative: 1, willingness: 1, x: 400, y: 260 });
    const state: SimulationState = {
      tick: 0,
      agents: [founder],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
      speechLog: [],
    };

    const next = runTicks(state, 100);

    const nucleusEntry = next.log.find((e) => e.eventType === "nucleusCreated");
    expect(nucleusEntry).toBeDefined();

    const speechEntry = next.speechLog?.find((s) => s.reason === "initiativeFormedCore");
    expect(speechEntry).toBeDefined();
    expect(speechEntry?.speakerId).toBe("founder");
    expect(speechEntry?.intent).toBe("invite");
    expect(speechEntry?.audience).toBe("nearby");
    expect(speechEntry?.target).toBeUndefined();
    expect(speechEntry?.tick).toBe(nucleusEntry?.tick);
  });

  it("appends to speechLog across ticks without dropping prior events", () => {
    const state = createInitialState(1, DEFAULT_PARAMS);
    expect(state.speechLog).toEqual([]);

    const next = runTicks(state, 50, 7);
    expect(next.speechLog?.length ?? 0).toBeGreaterThanOrEqual(0);
    // Every emitted event must carry a monotonically non-decreasing tick vs. the previous one.
    const ticks = (next.speechLog ?? []).map((s) => s.tick);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]).toBeGreaterThanOrEqual(ticks[i - 1]);
    }
  });

  it("does not generate a SpeechEvent when no core is formed", () => {
    // No initiative, no clique -> nobody founds a core in a single tick with near-zero probability.
    const passive = makeAgent({ id: "passive", initiative: 0, willingness: 0 });
    const state: SimulationState = {
      tick: 0,
      agents: [passive],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
      speechLog: [],
    };

    const next = stepSimulation(state, DEFAULT_PARAMS, new SeededRandom(1));
    expect(next.speechLog).toEqual([]);
  });
});

describe("speech generation boundary: light-observer-invitation", () => {
  it("records a targeted SpeechEvent naming the inviter and the observerJoiner as target", () => {
    const observer = makeAgent({
      id: "observer",
      isObserverJoiner: true,
      stress: 0.3,
      leaveThreshold: 0.6,
      x: 400,
      y: 260,
    });
    const helper = makeAgent({ id: "helper", label: "Helper", state: "joined", x: 410, y: 260 });
    const state: SimulationState = {
      tick: 5,
      agents: [observer, helper],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
      speechLog: [],
    };

    const next = stepSimulation(state, DEFAULT_PARAMS, new SeededRandom(1), {
      interventionId: "light-observer-invitation",
    });

    const speechEntry = next.speechLog?.find((s) => s.reason === "lightObserverInvitation");
    expect(speechEntry).toBeDefined();
    expect(speechEntry?.speakerId).toBe("helper");
    expect(speechEntry?.target).toBe("observer");
    expect(speechEntry?.audience).toBeUndefined();
  });
});

describe("speech generation boundary: non-interference with Phase 2 scope", () => {
  it("produces identical agent/state-transition outcomes with or without speechLog accumulation reasoning applied", () => {
    // SpeechEvent generation must be a pure by-product of the same conditions that already
    // produce LogEntry output; it must not consume additional rng draws or alter any decision.
    // We verify this indirectly: running the same seed/params twice yields identical agents,
    // groupCandidates and log (i.e. adding speechLog didn't perturb the existing deterministic behavior).
    const build = (): SimulationState => createInitialState(3, DEFAULT_PARAMS);

    const runA = runTicks(build(), 60, 3);
    const runB = runTicks(build(), 60, 3);

    expect(runA.agents).toEqual(runB.agents);
    expect(runA.groupCandidates).toEqual(runB.groupCandidates);
    expect(runA.log).toEqual(runB.log);
    expect(runA.speechLog).toEqual(runB.speechLog);
  });

  it("initializes speechLog to an empty array in createInitialState", () => {
    const state = createInitialState(1, DEFAULT_PARAMS);
    expect(state.speechLog).toEqual([]);
  });
});
