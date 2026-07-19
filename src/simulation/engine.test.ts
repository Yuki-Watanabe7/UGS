import { describe, expect, it } from "vitest";
import { attractiveness, createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS, getPresetById } from "./presets";
import type { InterventionRuntimeOptions } from "./interventions";
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

function runTicks(
  state: SimulationState,
  params = DEFAULT_PARAMS,
  seed = 1,
  ticks = 1,
  intervention?: InterventionRuntimeOptions,
): SimulationState {
  const rng = new SeededRandom(seed);
  let s = state;
  for (let i = 0; i < ticks; i++) {
    s = stepSimulation(s, params, rng, intervention);
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
      status: "forming",
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

    expect(next.groupCandidates[0].status).toBe("confirmed");
    expect(next.log.some((e) => e.message.includes("成立"))).toBe(true);
    expect(next.log.some((e) => e.tags.includes("groupConfirmed"))).toBe(true);
  });

  it("does not confirm when fewer members than groupConfirmSize are nearby", () => {
    const candidate: GroupCandidate = {
      id: "group-1",
      x: 400,
      y: 260,
      memberIds: ["agent-0"],
      status: "forming",
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

    expect(next.groupCandidates[0].status).toBe("forming");
  });
});

describe("stepSimulation: unconfirmed candidate lifecycle (dissolve/expire)", () => {
  it("dissolves a forming candidate that only the founder ever joined, after the weak-response window", () => {
    const candidate: GroupCandidate = {
      id: "group-1",
      x: 400,
      y: 260,
      memberIds: ["agent-0"],
      status: "forming",
      age: 14, // 次tickでweak-response期限(15)に到達する
    };
    const agents: Agent[] = [makeAgent({ id: "agent-0", state: "forming", x: 400, y: 260 })];
    const state: SimulationState = {
      tick: 14,
      agents,
      groupCandidates: [candidate],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const next = runTicks(state);

    expect(next.groupCandidates[0].status).toBe("dissolving");
    expect(next.log.some((e) => e.message.includes("自然消滅"))).toBe(true);
    expect(next.log.some((e) => e.tags.includes("groupLifecycle"))).toBe(true);
    // 輪を失ったfounderはundecidedに戻り、意思決定をやり直せる
    expect(next.agents[0].state).toBe("undecided");
  });

  it("expires a forming candidate that never reaches groupConfirmSize within the max age", () => {
    const candidate: GroupCandidate = {
      id: "group-1",
      x: 400,
      y: 260,
      memberIds: ["agent-0", "agent-1"],
      status: "forming",
      age: 39, // 次tickでmax age(40)に到達する
    };
    const agents: Agent[] = [
      makeAgent({ id: "agent-0", state: "forming", x: 400, y: 260 }),
      makeAgent({ id: "agent-1", state: "forming", x: 405, y: 262 }),
    ];
    const state: SimulationState = {
      tick: 39,
      agents,
      groupCandidates: [candidate],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const params = { ...DEFAULT_PARAMS, groupConfirmSize: 5 };
    const next = runTicks(state, params);

    expect(next.groupCandidates[0].status).toBe("expired");
    expect(next.log.some((e) => e.message.includes("時間切れ"))).toBe(true);
    expect(next.log.some((e) => e.tags.includes("groupLifecycle"))).toBe(true);
  });

  it("removes a dissolving/expired candidate from the array after it lingers past the fade-out window", () => {
    const candidate: GroupCandidate = {
      id: "group-1",
      x: 400,
      y: 260,
      memberIds: ["agent-0"],
      status: "dissolved",
      age: 3, // 猶予tick数(4)を次tickで超える
    };
    const state: SimulationState = {
      tick: 20,
      agents: [],
      groupCandidates: [candidate],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const next = runTicks(state);

    expect(next.groupCandidates).toHaveLength(0);
  });

  it("does not let undecided agents approach a dissolving/expired/dissolved candidate", () => {
    const params = DEFAULT_PARAMS;
    const statuses: GroupCandidate["status"][] = ["dissolving", "dissolved", "expired"];

    for (const status of statuses) {
      const candidate: GroupCandidate = {
        id: "group-1",
        x: 105,
        y: 260,
        memberIds: ["leader"],
        status,
        age: 1,
      };
      const observer = makeAgent({
        id: "agent-x",
        x: 100,
        y: 260,
        willingness: 1,
        conformity: 1,
        influenceAvoidance: 0,
      });
      const state: SimulationState = {
        tick: 1,
        agents: [observer],
        groupCandidates: [candidate],
        log: [],
        width: 800,
        height: 520,
        finished: false,
      };

      for (let seed = 0; seed < 20; seed++) {
        const next = runTicks(state, params, seed, 1);
        expect(next.agents[0].state).toBe("undecided");
      }
    }
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
          status: confirmed ? "confirmed" : "forming",
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
      status: "confirmed",
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
      status: "forming",
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
    expect(
      nextA.log.some(
        (e) => e.message.includes("observerJoinerが未確定の輪に合流") && e.tags.includes("observerJoiner"),
      ),
    ).toBe(true);

    const confirmedCandidate: GroupCandidate = {
      id: "group-2",
      x: 400,
      y: 260,
      memberIds: ["leader"],
      status: "confirmed",
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
    expect(
      nextB.log.some(
        (e) => e.message.includes("observerJoinerが成立済みグループに参加") && e.tags.includes("observerJoiner"),
      ),
    ).toBe(true);
  });
});

describe("stepSimulation: log tags", () => {
  it("tags the initial log entry as simulation", () => {
    const state = createInitialState(1, DEFAULT_PARAMS);
    expect(state.log[0].tags).toContain("simulation");
  });

  it("tags a nucleus-formation log with nucleus", () => {
    const founder = makeAgent({ id: "founder", initiative: 1, willingness: 1, x: 400, y: 260 });
    const state: SimulationState = {
      tick: 0,
      agents: [founder],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const next = runTicks(state, DEFAULT_PARAMS, 42, 100);

    expect(next.log.some((e) => e.tags.includes("nucleus"))).toBe(true);
  });

  it("tags both observerJoiner and leave when an observerJoiner gives up and leaves", () => {
    const observer = makeAgent({
      id: "observer",
      isObserverJoiner: true,
      willingness: 0.9,
      ambiguityTolerance: 0.05,
      influenceAvoidance: 0.9,
      leaveThreshold: 0.05,
    });
    const state: SimulationState = {
      tick: 0,
      agents: [observer],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const params = { ...DEFAULT_PARAMS, ambiguityDuration: 1 };
    const next = runTicks(state, params, 1, 50);

    const leaveEntry = next.log.find((e) => e.tags.includes("leave"));
    expect(leaveEntry).toBeDefined();
    expect(leaveEntry?.tags).toContain("observerJoiner");
  });

  it("tags a plain agent's leave log with leave only (not observerJoiner)", () => {
    const plain = makeAgent({
      id: "plain",
      isObserverJoiner: false,
      willingness: 0.9,
      ambiguityTolerance: 0.05,
      leaveThreshold: 0.05,
    });
    const state: SimulationState = {
      tick: 0,
      agents: [plain],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const params = { ...DEFAULT_PARAMS, ambiguityDuration: 1 };
    const next = runTicks(state, params, 1, 50);

    const leaveEntry = next.log.find((e) => e.tags.includes("leave"));
    expect(leaveEntry).toBeDefined();
    expect(leaveEntry?.tags).not.toContain("observerJoiner");
  });

  it("does not mutate the original log array when filtering by tag", () => {
    const observer = makeAgent({
      id: "observer",
      isObserverJoiner: true,
      willingness: 0.9,
      ambiguityTolerance: 0.05,
      influenceAvoidance: 0.9,
      leaveThreshold: 0.05,
    });
    const state: SimulationState = {
      tick: 0,
      agents: [observer],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const params = { ...DEFAULT_PARAMS, ambiguityDuration: 1 };
    const next = runTicks(state, params, 1, 50);
    const originalLength = next.log.length;

    const filtered = next.log.filter((e) => e.tags.includes("leave"));

    expect(filtered.length).toBeLessThanOrEqual(originalLength);
    expect(next.log.length).toBe(originalLength);
    expect(filtered).not.toBe(next.log);
  });
});

describe("stepSimulation: structured event metadata", () => {
  it("attaches simulationStarted to the initial log entry", () => {
    const state = createInitialState(1, DEFAULT_PARAMS);
    expect(state.log[0].eventType).toBe("simulationStarted");
  });

  it("attaches nucleusCreated with groupId/agentId to a nucleus-formation log", () => {
    const founder = makeAgent({ id: "founder", initiative: 1, willingness: 1, x: 400, y: 260 });
    const state: SimulationState = {
      tick: 0,
      agents: [founder],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const next = runTicks(state, DEFAULT_PARAMS, 42, 100);

    const nucleusEntry = next.log.find((e) => e.eventType === "nucleusCreated");
    expect(nucleusEntry).toBeDefined();
    expect(nucleusEntry?.metadata?.agentId).toBe("founder");
    expect(nucleusEntry?.metadata?.groupId).toBeDefined();
  });

  it("attaches groupConfirmed with memberCount to a group-confirmation log", () => {
    const candidate: GroupCandidate = {
      id: "group-1",
      x: 400,
      y: 260,
      memberIds: ["agent-0", "agent-1"],
      status: "forming",
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

    const confirmedEntry = next.log.find((e) => e.eventType === "groupConfirmed");
    expect(confirmedEntry).toBeDefined();
    expect(confirmedEntry?.metadata?.groupId).toBe("group-1");
    expect(confirmedEntry?.metadata?.memberCount).toBe(3);
  });

  it("attaches agentApproached (Issue #136) when a non-observerJoiner starts approaching a candidate", () => {
    const candidate: GroupCandidate = {
      id: "group-1",
      x: 405,
      y: 260,
      memberIds: ["founder"],
      status: "forming",
      age: 0,
    };
    const agents: Agent[] = [
      makeAgent({ id: "founder", state: "forming", x: 405, y: 260 }),
      // undecided, close enough that attractiveness/approachProbability isn't the bottleneck for this seed
      makeAgent({ id: "seeker", state: "undecided", x: 400, y: 260, willingness: 1, conformity: 1, influenceAvoidance: 0 }),
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

    // 候補との距離(5)がJOIN_DISTANCE(26)未満なため、接近を選んだ同一tick内でそのまま
    // joinedまで進むこともある。ここで確認したいのは"agentApproached"が記録されること自体なので、
    // 最終状態がapproaching/joinedいずれであってもよい
    let found: SimulationState | undefined;
    for (let seed = 1; seed <= 50 && !found; seed++) {
      const next = runTicks(state, DEFAULT_PARAMS, seed, 1);
      if (next.log.some((e) => e.eventType === "agentApproached" && e.metadata?.agentId === "seeker")) {
        found = next;
      }
    }

    expect(found).toBeDefined();
    const approachedEntry = found!.log.find((e) => e.eventType === "agentApproached");
    expect(approachedEntry).toBeDefined();
    expect(approachedEntry?.metadata).toMatchObject({ agentId: "seeker", agentLabel: "X", groupId: "group-1" });
    // observerJoiner専用のeventTypeはこのagentには発生しない
    expect(found!.log.some((e) => e.eventType === "observerApproached")).toBe(false);
  });

  it("tracks maxStress (Issue #136) as the running peak, independent of the current stress value", () => {
    // stressが既にピークへ達したあと引き下がった状態を再現し、maxStressがそのピークを保持し続ける
    // ことを確認する(通常のstress蓄積は増分が常に0以上のため、ここでは既に高いmaxStressを持つ
    // agentがさらにstressを蓄積してもmaxStressが現在値未満に落ちないことを検証する)
    const agent = makeAgent({ id: "solo", state: "undecided", stress: 0.1, maxStress: 0.8, willingness: 1, ambiguityTolerance: 0 });
    const state: SimulationState = {
      tick: 0,
      agents: [agent],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const next = runTicks(state, { ...DEFAULT_PARAMS, ambiguityDuration: 1 }, 1, 1);
    const solo = next.agents[0];

    expect(solo.stress).toBeGreaterThan(0.1);
    expect(solo.maxStress).toBeGreaterThanOrEqual(0.8);
    expect(solo.maxStress).toBeGreaterThanOrEqual(solo.stress);
  });

  it("records observerJoinedForming when an observerJoiner joins an unconfirmed candidate", () => {
    const unconfirmedCandidate: GroupCandidate = {
      id: "group-1",
      x: 400,
      y: 260,
      memberIds: ["leader"],
      status: "forming",
      age: 10,
    };
    const observer = makeAgent({
      id: "observer-a",
      isObserverJoiner: true,
      state: "approaching",
      x: 395,
      y: 258,
      joinedGroupId: "group-1",
    });
    const state: SimulationState = {
      tick: 5,
      agents: [observer],
      groupCandidates: [unconfirmedCandidate],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const next = runTicks(state);
    const entry = next.log.find((e) => e.eventType === "observerJoinedForming");
    expect(entry).toBeDefined();
    expect(entry?.metadata?.agentId).toBe("observer-a");
    expect(entry?.metadata?.joinedGroupStatus).toBe("forming");
  });

  it("records observerJoinedConfirmed when an observerJoiner joins a confirmed group", () => {
    const confirmedCandidate: GroupCandidate = {
      id: "group-2",
      x: 400,
      y: 260,
      memberIds: ["leader"],
      status: "confirmed",
      age: 10,
    };
    const observer = makeAgent({
      id: "observer-b",
      isObserverJoiner: true,
      state: "approaching",
      x: 395,
      y: 258,
      joinedGroupId: "group-2",
    });
    const state: SimulationState = {
      tick: 5,
      agents: [observer],
      groupCandidates: [confirmedCandidate],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const next = runTicks(state);
    const entry = next.log.find((e) => e.eventType === "observerJoinedConfirmed");
    expect(entry).toBeDefined();
    expect(entry?.metadata?.agentId).toBe("observer-b");
    expect(entry?.metadata?.joinedGroupStatus).toBe("confirmed");
  });

  it("records observerLeaveStarted when an observerJoiner gives up, distinct from observerLeft", () => {
    const observer = makeAgent({
      id: "observer",
      isObserverJoiner: true,
      willingness: 0.9,
      ambiguityTolerance: 0.05,
      influenceAvoidance: 0.9,
      leaveThreshold: 0.05,
    });
    const state: SimulationState = {
      tick: 0,
      agents: [observer],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const params = { ...DEFAULT_PARAMS, ambiguityDuration: 1 };
    const next = runTicks(state, params, 1, 50);

    const leaveStartedEntry = next.log.find((e) => e.eventType === "observerLeaveStarted");
    expect(leaveStartedEntry).toBeDefined();
    expect(leaveStartedEntry?.metadata?.agentId).toBe("observer");
    expect(leaveStartedEntry?.tick).toBeLessThan(
      next.log.find((e) => e.eventType === "observerLeft")?.tick ?? Infinity,
    );
  });

  it("records observerLeft once the observerJoiner reaches the bottom edge (left state)", () => {
    const observer = makeAgent({
      id: "observer",
      isObserverJoiner: true,
      state: "leaving",
      x: 400,
      y: 520 - 10,
    });
    const state: SimulationState = {
      tick: 0,
      agents: [observer],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const next = runTicks(state);
    expect(next.agents[0].state).toBe("left");
    const entry = next.log.find((e) => e.eventType === "observerLeft");
    expect(entry).toBeDefined();
    expect(entry?.metadata?.agentId).toBe("observer");
  });

  it("does not break existing tag-based EventLog filtering when eventType/metadata are present", () => {
    const observer = makeAgent({
      id: "observer",
      isObserverJoiner: true,
      willingness: 0.9,
      ambiguityTolerance: 0.05,
      influenceAvoidance: 0.9,
      leaveThreshold: 0.05,
    });
    const state: SimulationState = {
      tick: 0,
      agents: [observer],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const params = { ...DEFAULT_PARAMS, ambiguityDuration: 1 };
    const next = runTicks(state, params, 1, 50);

    const observerTagged = next.log.filter((e) => e.tags.includes("observerJoiner"));
    expect(observerTagged.length).toBeGreaterThan(0);
    for (const entry of observerTagged) {
      expect(Array.isArray(entry.tags)).toBe(true);
    }
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

describe("createInitialState/stepSimulation: intervention passthrough", () => {
  it("defaults to 'none' and keeps existing behavior when no intervention is given", () => {
    const state = createInitialState(1, DEFAULT_PARAMS);

    expect(state.interventionId).toBe("none");
    expect(state.log).toHaveLength(1);
    expect(state.log[0].eventType).toBe("simulationStarted");

    const next = stepSimulation(state, DEFAULT_PARAMS, new SeededRandom(1));
    expect(next.interventionId).toBe("none");
  });

  it("applies paramAdjustments to initial agent creation when an intervention is given", () => {
    const withIntervention = createInitialState(1, DEFAULT_PARAMS, {
      interventionId: "light-observer-invitation",
    });
    const withoutIntervention = createInitialState(1, DEFAULT_PARAMS);

    const observerWith = withIntervention.agents.find((a) => a.isObserverJoiner)!;
    const observerWithout = withoutIntervention.agents.find((a) => a.isObserverJoiner)!;

    expect(observerWith.influenceAvoidance).toBeLessThan(observerWithout.influenceAvoidance);
    expect(withIntervention.interventionId).toBe("light-observer-invitation");
  });

  it("logs an interventionApplied entry with the scenario id when a non-none intervention is used", () => {
    const state = createInitialState(1, DEFAULT_PARAMS, { interventionId: "late-join-ok" });

    const entry = state.log.find((e) => e.eventType === "interventionApplied");
    expect(entry).toBeDefined();
    expect(entry?.tags).toContain("intervention");
    expect(entry?.metadata?.interventionId).toBe("late-join-ok");
  });

  it("does not log an interventionApplied entry for 'none'", () => {
    const state = createInitialState(1, DEFAULT_PARAMS, { interventionId: "none" });
    expect(state.log.some((e) => e.eventType === "interventionApplied")).toBe(false);
  });

  it("carries the intervention forward across ticks even if stepSimulation isn't re-passed it", () => {
    let state = createInitialState(1, DEFAULT_PARAMS, { interventionId: "short-ambiguity-window" });
    const rng = new SeededRandom(1);

    for (let i = 0; i < 10; i++) {
      state = stepSimulation(state, DEFAULT_PARAMS, rng);
    }

    expect(state.interventionId).toBe("short-ambiguity-window");
  });

  it("applies the same paramAdjustments in stepSimulation as in createInitialState (fewer stress increments with a longer ambiguity window)", () => {
    const observer = makeAgent({
      id: "observer",
      isObserverJoiner: true,
      willingness: 0.9,
      ambiguityTolerance: 0.3,
      influenceAvoidance: 0.5,
      leaveThreshold: 0.95,
    });
    const baseState: SimulationState = {
      tick: 0,
      agents: [observer],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const withoutIntervention = stepSimulation(baseState, DEFAULT_PARAMS, new SeededRandom(1));
    const withIntervention = stepSimulation(baseState, DEFAULT_PARAMS, new SeededRandom(1), {
      interventionId: "short-ambiguity-window",
    });

    const stressWithout = withoutIntervention.agents[0].stress;
    const stressWith = withIntervention.agents[0].stress;

    expect(stressWith).toBeLessThan(stressWithout);
  });
});

describe("Phase C: explicit-meeting-point", () => {
  it("places a founder-less public meeting point candidate in the initial state, logged distinctly from natural nucleus formation", () => {
    const state = createInitialState(1, DEFAULT_PARAMS, { interventionId: "explicit-meeting-point" });

    expect(state.groupCandidates).toHaveLength(1);
    const meetingPoint = state.groupCandidates[0];
    expect(meetingPoint.isPublicMeetingPoint).toBe(true);
    expect(meetingPoint.status).toBe("forming");
    expect(meetingPoint.memberIds).toHaveLength(0);

    const entry = state.log.find((e) => e.eventType === "publicMeetingPointEstablished");
    expect(entry).toBeDefined();
    expect(entry?.tags).toContain("intervention");
    expect(entry?.tags).not.toContain("nucleus");
    expect(entry?.metadata?.groupId).toBe(meetingPoint.id);

    // 自然発生の核形成イベントとは区別される
    expect(state.log.some((e) => e.eventType === "nucleusCreated")).toBe(false);
  });

  it("does not place a meeting point candidate without the intervention", () => {
    const state = createInitialState(1, DEFAULT_PARAMS);
    expect(state.groupCandidates).toHaveLength(0);
    expect(state.log.some((e) => e.eventType === "publicMeetingPointEstablished")).toBe(false);
  });

  it("lowers the influenceAvoidance barrier when scoring a public meeting point vs. an equivalent private core", () => {
    const observer = makeAgent({
      id: "observer",
      isObserverJoiner: true,
      willingness: 0.8,
      influenceAvoidance: 0.9,
      conformity: 0.5,
    });
    const privateCore: GroupCandidate = {
      id: "group-1",
      x: 400,
      y: 260,
      memberIds: [],
      status: "forming",
      age: 0,
    };
    const meetingPoint: GroupCandidate = { ...privateCore, id: "group-2", isPublicMeetingPoint: true };

    const privateScore = attractiveness(observer, privateCore, [observer], DEFAULT_PARAMS);
    const meetingPointScore = attractiveness(observer, meetingPoint, [observer], DEFAULT_PARAMS);

    expect(meetingPointScore).toBeGreaterThan(privateScore);
  });

  it("exempts a public meeting point from the weak-response early dissolve, unlike an equivalent founder-less private core", () => {
    const params = DEFAULT_PARAMS;

    const buildState = (isPublicMeetingPoint: boolean): SimulationState => ({
      tick: 14,
      agents: [],
      groupCandidates: [
        {
          id: "group-1",
          x: 400,
          y: 260,
          memberIds: [],
          status: "forming",
          age: 14, // 次tickでweak-response期限(15)に到達する
          isPublicMeetingPoint,
        },
      ],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    });

    const nextPrivate = runTicks(buildState(false), params);
    expect(nextPrivate.groupCandidates[0].status).toBe("dissolving");

    const nextMeetingPoint = runTicks(buildState(true), params);
    expect(nextMeetingPoint.groupCandidates[0].status).toBe("forming");
  });
});

describe("Phase C: predecided-venue", () => {
  it("adds an attractiveness bonus for confirmed groups, increasing post-formation approach likelihood", () => {
    const agent = makeAgent({ id: "agent-0", willingness: 0.6, conformity: 0.5 });
    const confirmed: GroupCandidate = {
      id: "group-1",
      x: 400,
      y: 260,
      memberIds: [],
      status: "confirmed",
      age: 10,
    };

    const withoutIntervention = attractiveness(agent, confirmed, [agent], DEFAULT_PARAMS);
    const withIntervention = attractiveness(agent, confirmed, [agent], DEFAULT_PARAMS, "predecided-venue");

    expect(withIntervention).toBeGreaterThan(withoutIntervention);
  });

  it("lowers the observerJoiner's no-destination extra stress rate, isolated from the ambiguityDuration paramAdjustment", () => {
    const observer = makeAgent({
      id: "observer",
      isObserverJoiner: true,
      willingness: 0.9,
      ambiguityTolerance: 0.3,
      influenceAvoidance: 0.9,
      leaveThreshold: 0.95,
    });
    const baseState: SimulationState = {
      tick: 0,
      agents: [observer],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    // predecided-venueのparamAdjustmentsはlateJoinEaseのみ(ambiguityDuration非依存の
    // stress式には影響しない)ため、介入なしとの比較でも新しいengineロジック分だけが差分になる
    const withoutIntervention = stepSimulation(baseState, DEFAULT_PARAMS, new SeededRandom(1));
    const withIntervention = stepSimulation(baseState, DEFAULT_PARAMS, new SeededRandom(1), {
      interventionId: "predecided-venue",
    });

    expect(withIntervention.agents[0].stress).toBeLessThan(withoutIntervention.agents[0].stress);
  });
});

describe("Phase C: short-ambiguity-window (real engine effect beyond the ambiguityDuration paramAdjustment)", () => {
  it("dissolves a weak-response forming candidate earlier than without the intervention", () => {
    const founder = makeAgent({ id: "founder", state: "forming", x: 400, y: 260 });
    const buildState = (): SimulationState => ({
      tick: 6,
      agents: [founder],
      groupCandidates: [
        {
          id: "group-1",
          x: 400,
          y: 260,
          memberIds: ["founder"],
          status: "forming",
          age: 6,
        },
      ],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    });

    // accelerated threshold = round(15 * 0.5) = 8; age 6 -> +1 tick to 7 -> +1 tick to 8
    const withIntervention = runTicks(buildState(), DEFAULT_PARAMS, 1, 2, { interventionId: "short-ambiguity-window" });
    expect(withIntervention.groupCandidates[0].status).toBe("dissolving");

    const withoutIntervention = runTicks(buildState(), DEFAULT_PARAMS, 1, 2);
    expect(withoutIntervention.groupCandidates[0].status).toBe("forming");
  });

  it("lowers the observerJoiner's no-destination extra stress rate, on top of (not instead of) the ambiguityDuration paramAdjustment", () => {
    const observer = makeAgent({
      id: "observer",
      isObserverJoiner: true,
      willingness: 0.9,
      ambiguityTolerance: 0.3,
      influenceAvoidance: 0.9,
      leaveThreshold: 0.95,
    });
    const baseState: SimulationState = {
      tick: 0,
      agents: [observer],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    // ambiguityDurationのparamAdjustment(+0.2)を両条件で揃え、新しいストレス倍率分だけを分離して比較する
    const equivalentParams = { ...DEFAULT_PARAMS, ambiguityDuration: DEFAULT_PARAMS.ambiguityDuration + 0.2 };
    const withoutMultiplier = stepSimulation(baseState, equivalentParams, new SeededRandom(1));
    const withIntervention = stepSimulation(baseState, DEFAULT_PARAMS, new SeededRandom(1), {
      interventionId: "short-ambiguity-window",
    });

    expect(withIntervention.agents[0].stress).toBeLessThan(withoutMultiplier.agents[0].stress);
  });

  it("does not merely make the observerJoiner leave sooner: it delays (or does not accelerate) the leave tick vs. no intervention", () => {
    const params = { ...DEFAULT_PARAMS, ambiguityDuration: 0.4 };
    const observer = makeAgent({
      id: "observer",
      isObserverJoiner: true,
      willingness: 0.9,
      ambiguityTolerance: 0.2,
      influenceAvoidance: 0.9,
      leaveThreshold: 0.4,
    });
    const baseState: SimulationState = {
      tick: 0,
      agents: [observer],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const findLeaveTick = (intervention?: InterventionRuntimeOptions): number => {
      const rng = new SeededRandom(1);
      let state = baseState;
      for (let i = 0; i < 100; i++) {
        state = stepSimulation(state, params, rng, intervention);
        if (state.agents[0].state === "leaving" || state.agents[0].state === "left") return i;
      }
      return Infinity;
    };

    const leaveTickWithout = findLeaveTick();
    const leaveTickWith = findLeaveTick({ interventionId: "short-ambiguity-window" });

    expect(leaveTickWith).toBeGreaterThanOrEqual(leaveTickWithout);
  });
});

describe("Phase C: late-join-ok", () => {
  it("logs a distinct lateJoinPermissionAnnounced entry at the start", () => {
    const state = createInitialState(1, DEFAULT_PARAMS, { interventionId: "late-join-ok" });

    const entry = state.log.find((e) => e.eventType === "lateJoinPermissionAnnounced");
    expect(entry).toBeDefined();
    expect(entry?.tags).toContain("intervention");
  });

  it("does not log lateJoinPermissionAnnounced without the intervention", () => {
    const state = createInitialState(1, DEFAULT_PARAMS);
    expect(state.log.some((e) => e.eventType === "lateJoinPermissionAnnounced")).toBe(false);
  });

  it("adds an attractiveness bonus for confirmed groups beyond the lateJoinEase paramAdjustment alone", () => {
    const agent = makeAgent({ id: "agent-0", willingness: 0.6, conformity: 0.5 });
    const confirmed: GroupCandidate = {
      id: "group-1",
      x: 400,
      y: 260,
      memberIds: [],
      status: "confirmed",
      age: 10,
    };

    // 同じlateJoinEaseで比較し、attractiveness側の追加ボーナス分だけを分離する
    const withoutIntervention = attractiveness(agent, confirmed, [agent], DEFAULT_PARAMS);
    const withIntervention = attractiveness(agent, confirmed, [agent], DEFAULT_PARAMS, "late-join-ok");

    expect(withIntervention).toBeGreaterThan(withoutIntervention);
  });

  it("does not add a confirmed-group bonus to an unconfirmed (forming) candidate", () => {
    const agent = makeAgent({ id: "agent-0", willingness: 0.6, conformity: 0.5, influenceAvoidance: 0.3 });
    const forming: GroupCandidate = {
      id: "group-1",
      x: 400,
      y: 260,
      memberIds: [],
      status: "forming",
      age: 0,
    };

    const withoutIntervention = attractiveness(agent, forming, [agent], DEFAULT_PARAMS);
    const withIntervention = attractiveness(agent, forming, [agent], DEFAULT_PARAMS, "late-join-ok");

    expect(withIntervention).toBeCloseTo(withoutIntervention);
  });

  it("makes a clique-dominated confirmed group count as 'welcoming', lowering the observerJoiner's no-destination extra stress", () => {
    // dominant.ratio 0.67 (2/3) の成立済みグループ: 通常のしきい値(0.5)では「歓迎されていない」扱いだが、
    // late-join-okのしきい値(0.85)ではまだ「歓迎されている」扱いになる
    const observer = makeAgent({
      id: "observer",
      isObserverJoiner: true,
      cliqueId: 99,
      willingness: 0.9,
      ambiguityTolerance: 0.3,
      influenceAvoidance: 0.9,
      leaveThreshold: 0.95,
      x: 700,
      y: 260,
    });
    const memberA = makeAgent({ id: "member-a", cliqueId: 1, state: "joined", x: 400, y: 260 });
    const memberB = makeAgent({ id: "member-b", cliqueId: 1, state: "joined", x: 405, y: 262 });
    const memberC = makeAgent({ id: "member-c", cliqueId: 2, state: "joined", x: 402, y: 258 });
    const confirmed: GroupCandidate = {
      id: "group-1",
      x: 400,
      y: 260,
      memberIds: ["member-a", "member-b", "member-c"],
      status: "confirmed",
      age: 10,
    };
    const baseState: SimulationState = {
      tick: 0,
      agents: [observer, memberA, memberB, memberC],
      groupCandidates: [confirmed],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const withoutIntervention = stepSimulation(baseState, DEFAULT_PARAMS, new SeededRandom(1));
    const withIntervention = stepSimulation(baseState, DEFAULT_PARAMS, new SeededRandom(1), {
      interventionId: "late-join-ok",
    });

    const observerStressWithout = withoutIntervention.agents.find((a) => a.id === "observer")!.stress;
    const observerStressWith = withIntervention.agents.find((a) => a.id === "observer")!.stress;

    expect(observerStressWith).toBeLessThan(observerStressWithout);
  });
});

describe("Phase C: anonymous-low-pressure-intent", () => {
  it("logs a distinct anonymousIntentSignalAnnounced entry at the start", () => {
    const state = createInitialState(1, DEFAULT_PARAMS, { interventionId: "anonymous-low-pressure-intent" });

    const entry = state.log.find((e) => e.eventType === "anonymousIntentSignalAnnounced");
    expect(entry).toBeDefined();
    expect(entry?.tags).toContain("intervention");
  });

  it("does not log anonymousIntentSignalAnnounced without the intervention", () => {
    const state = createInitialState(1, DEFAULT_PARAMS);
    expect(state.log.some((e) => e.eventType === "anonymousIntentSignalAnnounced")).toBe(false);
  });

  it("lowers the observerJoiner's no-destination extra stress rate", () => {
    const observer = makeAgent({
      id: "observer",
      isObserverJoiner: true,
      willingness: 0.9,
      ambiguityTolerance: 0.3,
      influenceAvoidance: 0.9,
      leaveThreshold: 0.95,
    });
    const baseState: SimulationState = {
      tick: 0,
      agents: [observer],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const withoutIntervention = stepSimulation(baseState, DEFAULT_PARAMS, new SeededRandom(1));
    const withIntervention = stepSimulation(baseState, DEFAULT_PARAMS, new SeededRandom(1), {
      interventionId: "anonymous-low-pressure-intent",
    });

    expect(withIntervention.agents[0].stress).toBeLessThan(withoutIntervention.agents[0].stress);
  });

  it("increases approach probability toward an unconfirmed (forming) candidate more than a designated-leader-style boost would suggest, without touching observerInfluenceAvoidance to zero", () => {
    const params = DEFAULT_PARAMS;

    const countApproachOutcomes = (intervention: InterventionRuntimeOptions | undefined, trials: number): number => {
      let approachCount = 0;
      for (let seed = 0; seed < trials; seed++) {
        const agent = makeAgent({
          id: "agent-0",
          willingness: 0.6,
          initiative: 0.2,
          conformity: 0.6,
          influenceAvoidance: 0.4,
          x: 100,
          y: 260,
        });
        const candidate: GroupCandidate = {
          id: "group-1",
          x: 500,
          y: 260,
          memberIds: ["leader"],
          status: "forming",
          age: 10,
        };
        const state: SimulationState = {
          tick: 0,
          agents: [agent],
          groupCandidates: [candidate],
          log: [],
          width: 800,
          height: 520,
          finished: false,
        };
        const next = runTicks(state, params, seed + 200, 1, intervention);
        if (next.agents[0].state === "approaching" || next.agents[0].state === "joined") {
          approachCount += 1;
        }
      }
      return approachCount;
    };

    const trials = 300;
    const withoutIntervention = countApproachOutcomes(undefined, trials);
    const withIntervention = countApproachOutcomes({ interventionId: "anonymous-low-pressure-intent" }, trials);

    expect(withIntervention).toBeGreaterThan(withoutIntervention);
    // observerInfluenceAvoidanceはこの介入のparamAdjustmentsで下がるのみ(-0.3)であり、
    // ゼロになる過剰補正ではない
    const defaultAdjusted = DEFAULT_PARAMS.observerInfluenceAvoidance - 0.3;
    expect(defaultAdjusted).toBeGreaterThan(0);
  });
});

describe("Phase C: light-observer-invitation", () => {
  it("does not log observerInvited without the intervention", () => {
    const observer = makeAgent({ id: "observer", isObserverJoiner: true, stress: 0.3, leaveThreshold: 0.6 });
    const helper = makeAgent({ id: "helper", label: "Helper", state: "joined", x: 410, y: 260 });
    const state: SimulationState = {
      tick: 5,
      agents: [observer, helper],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const next = stepSimulation(state, DEFAULT_PARAMS, new SeededRandom(1));

    expect(next.agents.find((a) => a.id === "observer")?.invitedAtTick).toBeUndefined();
    expect(next.log.some((e) => e.eventType === "observerInvited")).toBe(false);
  });

  it("logs an observerInvited event naming the inviter once tick/stress conditions are met (seed-reproducible)", () => {
    const observer = makeAgent({
      id: "observer",
      isObserverJoiner: true,
      stress: 0.3,
      leaveThreshold: 0.6,
      x: 400,
      y: 260,
    });
    const helper = makeAgent({ id: "helper", label: "Helper", state: "joined", x: 410, y: 260 });
    const buildState = (): SimulationState => ({
      tick: 5,
      agents: [observer, helper],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    });

    const run = () =>
      stepSimulation(buildState(), DEFAULT_PARAMS, new SeededRandom(1), {
        interventionId: "light-observer-invitation",
      });

    const first = run();
    const second = run();

    const invitedObserver = first.agents.find((a) => a.id === "observer");
    expect(invitedObserver?.invitedAtTick).toBe(6);
    expect(second.agents.find((a) => a.id === "observer")?.invitedAtTick).toBe(invitedObserver?.invitedAtTick);

    const entry = first.log.find((e) => e.eventType === "observerInvited");
    expect(entry).toBeDefined();
    expect(entry?.tags).toEqual(expect.arrayContaining(["observerJoiner", "intervention"]));
    expect(entry?.metadata?.agentId).toBe("observer");
    expect(entry?.metadata?.inviterAgentId).toBe("helper");
    expect(second.log.find((e) => e.eventType === "observerInvited")?.metadata?.inviterAgentId).toBe("helper");
  });

  it("only invites once, even if the observerJoiner remains undecided and stressed for more ticks", () => {
    const observer = makeAgent({
      id: "observer",
      isObserverJoiner: true,
      stress: 0.3,
      leaveThreshold: 0.9,
      ambiguityTolerance: 0.9,
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
    };

    const next = runTicks(state, DEFAULT_PARAMS, 1, 3, { interventionId: "light-observer-invitation" });

    const invitedEntries = next.log.filter((e) => e.eventType === "observerInvited");
    expect(invitedEntries).toHaveLength(1);
  });

  it("falls back to the nearest non-observerJoiner agent as inviter when no one nearby is engaged", () => {
    const observer = makeAgent({
      id: "observer",
      isObserverJoiner: true,
      stress: 0.3,
      leaveThreshold: 0.6,
      x: 400,
      y: 260,
    });
    const far = makeAgent({ id: "far", label: "Far", state: "undecided", x: 10, y: 10 });
    const closer = makeAgent({ id: "closer", label: "Closer", state: "undecided", x: 450, y: 280 });
    const state: SimulationState = {
      tick: 5,
      agents: [observer, far, closer],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const next = stepSimulation(state, DEFAULT_PARAMS, new SeededRandom(1), {
      interventionId: "light-observer-invitation",
    });

    const entry = next.log.find((e) => e.eventType === "observerInvited");
    expect(entry?.metadata?.inviterAgentId).toBe("closer");
  });

  it("increases approach probability toward a nearby candidate for an already-invited observerJoiner", () => {
    const params = DEFAULT_PARAMS;

    const countApproachOutcomes = (invited: boolean, trials: number): number => {
      let approachCount = 0;
      for (let seed = 0; seed < trials; seed++) {
        const observer = makeAgent({
          id: "observer",
          isObserverJoiner: true,
          willingness: 0.8,
          influenceAvoidance: 0.6,
          conformity: 0.6,
          x: 100,
          y: 260,
          invitedAtTick: invited ? 0 : undefined,
        });
        const candidate: GroupCandidate = {
          id: "group-1",
          x: 500,
          y: 260,
          memberIds: ["leader"],
          status: "forming",
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
        const next = runTicks(state, params, seed + 500, 1, { interventionId: "light-observer-invitation" });
        if (next.agents[0].state === "approaching" || next.agents[0].state === "joined") {
          approachCount += 1;
        }
      }
      return approachCount;
    };

    const trials = 300;
    const withoutBoost = countApproachOutcomes(false, trials);
    const withBoost = countApproachOutcomes(true, trials);

    expect(withBoost).toBeGreaterThan(withoutBoost);
  });

  it("lowers the already-invited observerJoiner's no-destination extra stress rate", () => {
    const observer = makeAgent({
      id: "observer",
      isObserverJoiner: true,
      willingness: 0.9,
      ambiguityTolerance: 0.3,
      influenceAvoidance: 0.9,
      leaveThreshold: 0.95,
    });
    const baseState: SimulationState = {
      tick: 0,
      agents: [observer],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const withoutIntervention = stepSimulation(baseState, DEFAULT_PARAMS, new SeededRandom(1));
    const invitedState: SimulationState = {
      ...baseState,
      agents: [{ ...observer, invitedAtTick: 0 }],
    };
    const withIntervention = stepSimulation(invitedState, DEFAULT_PARAMS, new SeededRandom(1), {
      interventionId: "light-observer-invitation",
    });

    expect(withIntervention.agents[0].stress).toBeLessThan(withoutIntervention.agents[0].stress);
  });
});
