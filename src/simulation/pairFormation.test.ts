import { describe, expect, it } from "vitest";
import { buildPairFormationRunSummary, summarizePairFormationRuns } from "./pairFormation";
import { runPairFormationMonteCarlo } from "./monteCarlo";
import { DEFAULT_PARAMS, getPresetById } from "./presets";
import type { Agent, LogEntry, MonteCarloConfig, SimulationState } from "./types";

/**
 * Issue #136: ペア/グループ形成過程の集計(未割当・参加失敗・再探索)のテスト。
 * `groupCapacity.test.ts`/`approachFailure.test.ts`/`classroomPair.test.ts`(構造化イベントそのものの
 * 単体テスト)とは別に、ここではそれらのイベント/agentフィールドから正しく集計できることを検証する。
 */

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

function groupConfirmedEntry(tick: number, groupId: string, memberCount: number): LogEntry {
  return {
    tick,
    message: `${groupId} confirmed`,
    tags: ["groupConfirmed"],
    eventType: "groupConfirmed",
    metadata: { groupId, memberCount },
  };
}

describe("buildPairFormationRunSummary: 成立ペア数・成立tick・最後に割当されたagent", () => {
  it("最初/最後の成立tickと、最後に成立した候補へ最後に加わったagentを導出する", () => {
    const agents: Agent[] = [
      makeAgent({ id: "a", label: "A", state: "joined", joinedGroupId: "pair-1" }),
      makeAgent({ id: "b", label: "B", state: "joined", joinedGroupId: "pair-1" }),
      makeAgent({ id: "c", label: "C", state: "joined", joinedGroupId: "pair-2" }),
      makeAgent({ id: "d", label: "D", state: "joined", joinedGroupId: "pair-2" }),
    ];
    const state = makeState({
      agents,
      groupCandidates: [
        { id: "pair-1", x: 0, y: 0, memberIds: ["a", "b"], status: "confirmed", age: 3 },
        { id: "pair-2", x: 0, y: 0, memberIds: ["c", "d"], status: "confirmed", age: 3 },
      ],
      log: [groupConfirmedEntry(5, "pair-1", 2), groupConfirmedEntry(12, "pair-2", 2)],
      finished: true,
    });

    const summary = buildPairFormationRunSummary(state, DEFAULT_PARAMS);

    expect(summary.confirmedPairCount).toBe(2);
    expect(summary.firstPairConfirmedTick).toBe(5);
    expect(summary.lastPairConfirmedTick).toBe(12);
    expect(summary.lastAssignedAgent).toEqual({ agentId: "d", label: "D", tick: 12, groupId: "pair-2" });
    expect(summary.assignedCount).toBe(4);
    expect(summary.unassignedCount).toBe(0);
  });

  it("成立イベントが1件もなければ、成立関連フィールドは全てundefined", () => {
    const state = makeState({ agents: [makeAgent({ id: "a" })] });

    const summary = buildPairFormationRunSummary(state, DEFAULT_PARAMS);

    expect(summary.confirmedPairCount).toBe(0);
    expect(summary.firstPairConfirmedTick).toBeUndefined();
    expect(summary.lastPairConfirmedTick).toBeUndefined();
    expect(summary.lastAssignedAgent).toBeUndefined();
    expect(summary.sameCliquePairRate).toBeUndefined();
    expect(summary.crossCliquePairRate).toBeUndefined();
  });
});

describe("buildPairFormationRunSummary: agent別の接近回数・参加失敗回数・再探索回数", () => {
  it("agentApproached/observerApproachedのeventTypeから接近回数を、参加失敗イベントから失敗回数を数える", () => {
    const agents: Agent[] = [
      makeAgent({ id: "normal", label: "N", isObserverJoiner: false, searchRestartCount: 1, capacityFailureCount: 1 }),
      makeAgent({ id: "observer", label: "O", isObserverJoiner: true }),
    ];
    const log: LogEntry[] = [
      { tick: 1, message: "", tags: [], eventType: "agentApproached", metadata: { agentId: "normal" } },
      { tick: 2, message: "", tags: [], eventType: "agentApproached", metadata: { agentId: "normal" } },
      {
        tick: 3,
        message: "",
        tags: ["joinFailure"],
        eventType: "joinFailedCapacity",
        metadata: { agentId: "normal", reason: "capacityFull" },
      },
      { tick: 4, message: "", tags: ["observerJoiner"], eventType: "observerApproached", metadata: { agentId: "observer" } },
      {
        tick: 5,
        message: "",
        tags: ["observerJoiner", "joinFailure"],
        eventType: "approachTargetInvalidated",
        metadata: { agentId: "observer", reason: "groupDissolved" },
      },
    ];
    const state = makeState({ agents, log });

    const summary = buildPairFormationRunSummary(state, DEFAULT_PARAMS);

    const normal = summary.agentMetrics.find((m) => m.agentId === "normal")!;
    expect(normal.approachCount).toBe(2);
    expect(normal.joinFailureCount).toBe(1);
    expect(normal.searchRestartCount).toBe(1);
    expect(normal.capacityFailureCount).toBe(1);

    const observer = summary.agentMetrics.find((m) => m.agentId === "observer")!;
    expect(observer.approachCount).toBe(1);
    expect(observer.joinFailureCount).toBe(1);
  });

  it("population平均とobserverJoiner平均を分離する", () => {
    const agents: Agent[] = [
      makeAgent({ id: "n1", isObserverJoiner: false, searchRestartCount: 2 }),
      makeAgent({ id: "n2", isObserverJoiner: false, searchRestartCount: 0 }),
      makeAgent({ id: "o1", isObserverJoiner: true, searchRestartCount: 4 }),
    ];
    const state = makeState({ agents });

    const summary = buildPairFormationRunSummary(state, DEFAULT_PARAMS);

    expect(summary.populationAverages.averageSearchRestartCount).toBeCloseTo((2 + 0 + 4) / 3, 6);
    expect(summary.observerJoinerAverages.averageSearchRestartCount).toBeCloseTo(4, 6);
  });

  it("observerJoinerが1人もいなければobserverJoiner平均は全て0", () => {
    const state = makeState({ agents: [makeAgent({ id: "n1", isObserverJoiner: false, searchRestartCount: 3 })] });

    const summary = buildPairFormationRunSummary(state, DEFAULT_PARAMS);

    expect(summary.observerJoinerAverages).toEqual({
      averageApproachCount: 0,
      averageJoinFailureCount: 0,
      averageSearchRestartCount: 0,
      averageCapacityFailureCount: 0,
      averageMaxStress: 0,
      averageFinalStress: 0,
    });
  });
});

describe("buildPairFormationRunSummary: 最大stress・締切時stress", () => {
  it("maxStressが記録されていればそれを、無ければ現在のstressをmaxStressとして使う", () => {
    const agents: Agent[] = [
      makeAgent({ id: "peaked", stress: 0.2, maxStress: 0.9 }),
      makeAgent({ id: "no-history", stress: 0.4 }),
    ];
    const state = makeState({ agents });

    const summary = buildPairFormationRunSummary(state, DEFAULT_PARAMS);

    const peaked = summary.agentMetrics.find((m) => m.agentId === "peaked")!;
    expect(peaked.maxStress).toBe(0.9);
    expect(peaked.finalStress).toBe(0.2);

    const noHistory = summary.agentMetrics.find((m) => m.agentId === "no-history")!;
    expect(noHistory.maxStress).toBe(0.4);
    expect(noHistory.finalStress).toBe(0.4);
  });
});

describe("buildPairFormationRunSummary: 同一clique内ペア率・clique外ペア率", () => {
  it("成立したグループのうち、全員同一cliqueだった割合をsameCliquePairRateとして返す", () => {
    const agents: Agent[] = [
      makeAgent({ id: "a", cliqueId: 1 }),
      makeAgent({ id: "b", cliqueId: 1 }),
      makeAgent({ id: "c", cliqueId: 1 }),
      makeAgent({ id: "d", cliqueId: 2 }),
    ];
    const state = makeState({
      agents,
      groupCandidates: [
        { id: "same-clique", x: 0, y: 0, memberIds: ["a", "b"], status: "confirmed", age: 1 },
        { id: "cross-clique", x: 0, y: 0, memberIds: ["c", "d"], status: "confirmed", age: 1 },
      ],
    });

    const summary = buildPairFormationRunSummary(state, DEFAULT_PARAMS);

    expect(summary.sameCliquePairRate).toBeCloseTo(0.5, 6);
    expect(summary.crossCliquePairRate).toBeCloseTo(0.5, 6);
  });

  it("cliqueIdが未設定のagentを含むペアはclique外(同一とはみなさない)", () => {
    const agents: Agent[] = [makeAgent({ id: "a", cliqueId: 1 }), makeAgent({ id: "b" })];
    const state = makeState({
      agents,
      groupCandidates: [{ id: "mixed", x: 0, y: 0, memberIds: ["a", "b"], status: "confirmed", age: 1 }],
    });

    const summary = buildPairFormationRunSummary(state, DEFAULT_PARAMS);

    expect(summary.sameCliquePairRate).toBe(0);
    expect(summary.crossCliquePairRate).toBe(1);
  });
});

describe("buildPairFormationRunSummary: 奇数人数の必然的未割当と追加的未割当の区別", () => {
  it("classroomPair(固定2人定員)では、人口を2で割った余りをstructuralUnassignedFloorとして返す", () => {
    const agents: Agent[] = Array.from({ length: 19 }, (_, i) => makeAgent({ id: `a${i}` }));
    const state = makeState({ agents, formationScenarioId: "classroomPair", formationDeadlineTick: 100 });

    const summary = buildPairFormationRunSummary(state, DEFAULT_PARAMS);

    expect(summary.structuralUnassignedFloor).toBe(1);
  });

  it("実際の未割当人数がfloorちょうどなら、excessUnassignedCountは0", () => {
    const agents: Agent[] = [
      ...Array.from({ length: 18 }, (_, i) => makeAgent({ id: `a${i}`, state: "joined" })),
      makeAgent({ id: "leftover", state: "unassigned" }),
    ];
    const state = makeState({ agents, formationScenarioId: "classroomPair", formationDeadlineTick: 100 });

    const summary = buildPairFormationRunSummary(state, DEFAULT_PARAMS);

    expect(summary.unassignedCount).toBe(1);
    expect(summary.structuralUnassignedFloor).toBe(1);
    expect(summary.excessUnassignedCount).toBe(0);
  });

  it("floorを超える未割当がある場合はexcessUnassignedCountが正の値になる", () => {
    const agents: Agent[] = [
      ...Array.from({ length: 16 }, (_, i) => makeAgent({ id: `a${i}`, state: "joined" })),
      makeAgent({ id: "leftover-1", state: "unassigned" }),
      makeAgent({ id: "leftover-2", state: "unassigned" }),
      makeAgent({ id: "leftover-3", state: "unassigned" }),
    ];
    const state = makeState({ agents, formationScenarioId: "classroomPair", formationDeadlineTick: 100 });

    const summary = buildPairFormationRunSummary(state, DEFAULT_PARAMS);

    expect(summary.unassignedCount).toBe(3);
    expect(summary.structuralUnassignedFloor).toBe(1);
    expect(summary.excessUnassignedCount).toBe(2);
  });

  it("afterParty(実質無制限の定員)ではstructuralUnassignedFloor/excessUnassignedCountはundefined", () => {
    const agents: Agent[] = Array.from({ length: 19 }, (_, i) => makeAgent({ id: `a${i}` }));
    const state = makeState({ agents, formationScenarioId: "afterParty" });

    const summary = buildPairFormationRunSummary(state, DEFAULT_PARAMS);

    expect(summary.structuralUnassignedFloor).toBeUndefined();
    expect(summary.excessUnassignedCount).toBeUndefined();
  });
});

describe("summarizePairFormationRuns: Monte Carlo集計", () => {
  it("全員割当率・平均未割当人数・完了tick分布・属性別未割当率を集計する", () => {
    const pairFormationRuns = [
      buildPairFormationRunSummary(
        makeState({
          agents: [
            makeAgent({ id: "a", state: "joined", isObserverJoiner: false }),
            makeAgent({ id: "b", state: "joined", isObserverJoiner: true }),
          ],
          formationScenarioId: "classroomPair",
        }),
        DEFAULT_PARAMS,
      ),
      buildPairFormationRunSummary(
        makeState({
          agents: [
            makeAgent({ id: "c", state: "unassigned", isObserverJoiner: false }),
            makeAgent({ id: "d", state: "unassigned", isObserverJoiner: true }),
          ],
          formationScenarioId: "classroomPair",
        }),
        DEFAULT_PARAMS,
      ),
    ];
    const runs = [
      { seed: 1, summary: {} as never, finishedTick: 10 },
      { seed: 2, summary: {} as never, finishedTick: 20 },
    ];

    const summary = summarizePairFormationRuns(runs, pairFormationRuns);

    expect(summary.runs).toBe(2);
    expect(summary.allAssignedRate).toBeCloseTo(0.5, 6);
    expect(summary.averageUnassignedCount).toBeCloseTo(1, 6);
    expect(summary.finishedTickDistribution).toEqual([10, 20]);
    expect(summary.unassignedRateByAttribute.observerJoiner).toBeCloseTo(0.5, 6);
    expect(summary.unassignedRateByAttribute.population).toBeCloseTo(0.5, 6);
  });

  it("runsが空なら、割合系は0・分布系は空配列・条件付き集計はundefinedを返す", () => {
    const summary = summarizePairFormationRuns([], []);

    expect(summary.runs).toBe(0);
    expect(summary.allAssignedRate).toBe(0);
    expect(summary.allAssignableRate).toBeUndefined();
    expect(summary.averageUnassignedCount).toBe(0);
    expect(summary.finishedTickDistribution).toEqual([]);
    expect(summary.averageSameCliquePairRate).toBeUndefined();
  });
});

describe("runPairFormationMonteCarlo: classroomPairシナリオでの複数seed集計(統合テスト)", () => {
  const preset = getPresetById("classroom-pair");

  it("奇数人口では全員割当率が1未満でも、allAssignableRateが理論上の割当可能性を反映する", () => {
    const params = { ...preset.params, populationSize: 19 };
    const config: MonteCarloConfig = {
      baseSeed: 500,
      runs: 5,
      params,
      formation: { scenarioId: "classroomPair", formationDeadlineTick: preset.formationDeadlineTick },
    };

    const result = runPairFormationMonteCarlo(config);

    expect(result.pairFormationRuns).toHaveLength(5);
    expect(result.pairFormationSummary.runs).toBe(5);
    for (const run of result.pairFormationRuns) {
      expect(run.structuralUnassignedFloor).toBe(1);
      expect(run.unassignedCount).toBeGreaterThanOrEqual(1);
    }
    expect(result.pairFormationSummary.allAssignableRate).toBeGreaterThan(0);
    expect(result.pairFormationSummary.finishedTickDistribution).toHaveLength(5);
  });

  it("同一seed列で集計結果が再現される(受入条件)", () => {
    const config: MonteCarloConfig = {
      baseSeed: 42,
      runs: 3,
      params: preset.params,
      formation: { scenarioId: "classroomPair", formationDeadlineTick: preset.formationDeadlineTick },
    };

    const run1 = runPairFormationMonteCarlo(config);
    const run2 = runPairFormationMonteCarlo(config);

    expect(run2.pairFormationRuns).toEqual(run1.pairFormationRuns);
    expect(run2.pairFormationSummary).toEqual(run1.pairFormationSummary);
  });

  it("二次会(afterParty)Monte Carloの既存指標(summary)に回帰がない(受入条件)", () => {
    const config: MonteCarloConfig = {
      baseSeed: 10,
      runs: 5,
      params: DEFAULT_PARAMS,
    };

    const result = runPairFormationMonteCarlo(config);

    expect(result.summary.runs).toBe(5);
    expect(result.pairFormationSummary.averageExcessUnassignedCount).toBeUndefined();
    expect(result.pairFormationSummary.allAssignableRate).toBeUndefined();
  });
});
