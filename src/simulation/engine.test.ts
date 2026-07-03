import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS, getPresetById } from "./presets";
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

function runTicks(state: SimulationState, params = DEFAULT_PARAMS, seed = 1, ticks = 1): SimulationState {
  const rng = new SeededRandom(seed);
  let s = state;
  for (let i = 0; i < ticks; i++) {
    s = stepSimulation(s, params, rng);
  }
  return s;
}

describe("stepSimulation: group confirmation", () => {
  it("confirms a group candidate once enough members gather nearby", () => {
    const candidate: GroupCandidate = {
      id: "group-1",
      x: 400,
      y: 260,
      memberIds: ["agent-0", "agent-1"],
      confirmed: false,
      age: 5,
    };
    const agents: Agent[] = [
      makeAgent({ id: "agent-0", state: "forming", x: 400, y: 260 }),
      makeAgent({ id: "agent-1", state: "joined", x: 410, y: 260, joinedGroupId: "group-1" }),
      makeAgent({ id: "agent-2", state: "approaching", x: 395, y: 265, joinedGroupId: "group-1" }),
    ];
    const state: SimulationState = {
      tick: 5,
      agents,
      groupCandidates: [candidate],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const params = { ...DEFAULT_PARAMS, groupConfirmSize: 3 };
    const next = runTicks(state, params);

    expect(next.groupCandidates[0].confirmed).toBe(true);
    expect(next.log.some((e) => e.message.includes("成立"))).toBe(true);
  });

  it("does not confirm when fewer members than groupConfirmSize are nearby", () => {
    const candidate: GroupCandidate = {
      id: "group-1",
      x: 400,
      y: 260,
      memberIds: ["agent-0"],
      confirmed: false,
      age: 5,
    };
    const agents: Agent[] = [makeAgent({ id: "agent-0", state: "forming", x: 400, y: 260 })];
    const state: SimulationState = {
      tick: 5,
      agents,
      groupCandidates: [candidate],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const params = { ...DEFAULT_PARAMS, groupConfirmSize: 3 };
    const next = runTicks(state, params);

    expect(next.groupCandidates[0].confirmed).toBe(false);
  });
});

describe("stepSimulation: stress and leaving", () => {
  it("agents with low ambiguityTolerance reach leaving state faster than tolerant agents", () => {
    const params = { ...DEFAULT_PARAMS, ambiguityDuration: 1 };

    const lowTolerance = makeAgent({
      id: "low",
      willingness: 0.9,
      ambiguityTolerance: 0.05,
      leaveThreshold: 0.3,
    });
    const highTolerance = makeAgent({
      id: "high",
      willingness: 0.9,
      ambiguityTolerance: 0.95,
      leaveThreshold: 0.3,
    });

    const baseState = (agent: Agent): SimulationState => ({
      tick: 0,
      agents: [agent],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    });

    const findLeaveTick = (agent: Agent): number => {
      const rng = new SeededRandom(1);
      let state = baseState(agent);
      for (let i = 0; i < 200; i++) {
        state = stepSimulation(state, params, rng);
        if (state.agents[0].state === "leaving" || state.agents[0].state === "left") {
          return i;
        }
      }
      return Infinity;
    };

    const lowTick = findLeaveTick(lowTolerance);
    const highTick = findLeaveTick(highTolerance);

    expect(lowTick).toBeLessThan(highTick);
  });

  it("observerJoiner accumulates extra stress while no confirmed group exists", () => {
    const params = DEFAULT_PARAMS;
    const observer = makeAgent({
      id: "observer",
      isObserverJoiner: true,
      willingness: 0.8,
      initiative: 0.1,
      ambiguityTolerance: 0.25,
      influenceAvoidance: 0.9,
      conformity: 0.5,
      leaveThreshold: 0.4,
    });
    const nonObserver = makeAgent({
      id: "plain",
      willingness: 0.8,
      ambiguityTolerance: 0.25,
      influenceAvoidance: 0.9,
      leaveThreshold: 0.4,
    });

    const state: SimulationState = {
      tick: 0,
      agents: [observer, nonObserver],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const next = runTicks(state, params, 1, 1);
    const observerAfter = next.agents.find((a) => a.id === "observer")!;
    const plainAfter = next.agents.find((a) => a.id === "plain")!;

    expect(observerAfter.stress).toBeGreaterThan(plainAfter.stress);
  });
});

describe("stepSimulation: observerJoiner approach behavior", () => {
  it("approaches a confirmed group more readily than an unconfirmed one", () => {
    const params = DEFAULT_PARAMS;

    const countApproachOutcomes = (confirmed: boolean, trials: number): number => {
      let approachCount = 0;
      for (let seed = 0; seed < trials; seed++) {
        const observer = makeAgent({
          id: "observer",
          isObserverJoiner: true,
          willingness: 0.8,
          initiative: 0.1,
          ambiguityTolerance: 0.25,
          influenceAvoidance: 0.9,
          conformity: 0.5,
          leaveThreshold: 0.4,
          x: 100,
          y: 260,
        });
        const candidate: GroupCandidate = {
          id: "group-1",
          x: 500,
          y: 260,
          memberIds: ["leader"],
          confirmed,
          age: 10,
        };
        const state: SimulationState = {
          tick: 0,
          agents: [observer],
          groupCandidates: [candidate],
          log: [],
          width: 800,
          height: 520,
          finished: false,
        };
        // one tick is enough to *decide* to move, but too far to arrive —
        // so "approaching" reliably captures "chose to move toward the group"
        const next = runTicks(state, params, seed + 100, 1);
        if (next.agents[0].state === "approaching" || next.agents[0].state === "joined") {
          approachCount += 1;
        }
      }
      return approachCount;
    };

    const trials = 200;
    const confirmedApproaches = countApproachOutcomes(true, trials);
    const unconfirmedApproaches = countApproachOutcomes(false, trials);

    expect(confirmedApproaches).toBeGreaterThan(unconfirmedApproaches);
  });
});

describe("stepSimulation: memberIds integrity", () => {
  it("does not duplicate an agent's id when joining a confirmed candidate it already belongs to", () => {
    const candidate: GroupCandidate = {
      id: "group-1",
      x: 400,
      y: 260,
      memberIds: ["agent-0"],
      confirmed: true,
      age: 10,
    };
    const agent = makeAgent({
      id: "agent-0",
      state: "approaching",
      x: 395,
      y: 258,
      joinedGroupId: "group-1",
    });
    const state: SimulationState = {
      tick: 5,
      agents: [agent],
      groupCandidates: [candidate],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const next = runTicks(state);
    const updated = next.groupCandidates.find((c) => c.id === "group-1")!;
    expect(updated.memberIds.filter((id) => id === "agent-0")).toHaveLength(1);
  });
});

describe("stepSimulation: observerJoiner arrival logging", () => {
  it("distinguishes joining an unconfirmed candidate from joining a confirmed group", () => {
    const unconfirmedCandidate: GroupCandidate = {
      id: "group-1",
      x: 400,
      y: 260,
      memberIds: ["leader"],
      confirmed: false,
      age: 10,
    };
    const observerA = makeAgent({
      id: "observer-a",
      isObserverJoiner: true,
      state: "approaching",
      x: 395,
      y: 258,
      joinedGroupId: "group-1",
    });
    const stateA: SimulationState = {
      tick: 5,
      agents: [observerA],
      groupCandidates: [unconfirmedCandidate],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };
    const nextA = runTicks(stateA);
    expect(nextA.log.some((e) => e.message.includes("observerJoinerが未確定の輪に合流"))).toBe(true);

    const confirmedCandidate: GroupCandidate = {
      id: "group-2",
      x: 400,
      y: 260,
      memberIds: ["leader"],
      confirmed: true,
      age: 10,
    };
    const observerB = makeAgent({
      id: "observer-b",
      isObserverJoiner: true,
      state: "approaching",
      x: 395,
      y: 258,
      joinedGroupId: "group-2",
    });
    const stateB: SimulationState = {
      tick: 5,
      agents: [observerB],
      groupCandidates: [confirmedCandidate],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };
    const nextB = runTicks(stateB);
    expect(nextB.log.some((e) => e.message.includes("observerJoinerが成立済みグループに参加"))).toBe(true);
  });
});

describe("preset behavior", () => {
  it("leader-heavy presets form group candidates sooner than the ambiguous-dissolve preset", () => {
    const firstCandidateTick = (presetId: string, seed: number): number => {
      const preset = getPresetById(presetId);
      const rng = new SeededRandom(seed);
      let state = createInitialState(seed, preset.params);
      for (let i = 0; i < 100; i++) {
        state = stepSimulation(state, preset.params, rng);
        if (state.groupCandidates.length > 0) return i;
      }
      return Infinity;
    };

    const seeds = [1, 2, 3, 4, 5];
    const naturalTicks = seeds.map((s) => firstCandidateTick("natural", s));
    const ambiguousTicks = seeds.map((s) => firstCandidateTick("ambiguous-dissolve", s));

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

    expect(avg(naturalTicks)).toBeLessThan(avg(ambiguousTicks));
  });
});
