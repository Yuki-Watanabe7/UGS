import { describe, expect, it } from "vitest";
import { compareGroupFormation, runGroupFormationMonteCarlo } from "./groupFormation";
import { DEFAULT_PARAMS } from "./presets";
import type { FormationRuntimeOptions, GroupSizeRule } from "./formationPolicy";
import type { MonteCarloConfig } from "./types";

/**
 * Issue #160 (Phase 4): `groupFormation.ts`(#136の`pairFormation.ts`を一般化し、教師介入の
 * 副作用指標(推薦受諾・強制割当・再配分・ランダム割当)を積み増したレイヤー)のテスト。
 * 個々の介入自体の構造化イベント発行ロジックは`schoolInterventions.test.ts`/
 * `schoolInterventions/*.test.ts`で既に検証済みのため、ここではそれらのイベントから
 * `groupFormation.ts`が正しく集計・比較できることに焦点を当てる。
 */

function classroomFormation(groupSize: GroupSizeRule, deadlineTick = 40): FormationRuntimeOptions {
  return { scenarioId: "classroomPair", formationDeadlineTick: deadlineTick, classroomGroupSize: groupSize };
}

describe("compareGroupFormation: paired比較の基本契約", () => {
  it("baseline/interventionのseed列が一致する", () => {
    const config: MonteCarloConfig = {
      baseSeed: 500,
      runs: 5,
      params: { ...DEFAULT_PARAMS, populationSize: 12, numLeaders: 1, overallWillingness: 0.5 },
      intervention: { interventionId: "teacher-recommendation" },
      formation: classroomFormation({ minGroupSize: 2, maxGroupSize: 2 }),
    };

    const result = compareGroupFormation(config);

    const baselineSeeds = result.baseline.runs.map((run) => run.seed);
    const interventionSeeds = result.intervention.runs.map((run) => run.seed);
    expect(baselineSeeds).toEqual([500, 501, 502, 503, 504]);
    expect(interventionSeeds).toEqual(baselineSeeds);
    expect(result.pairedSeeds).toEqual(baselineSeeds);
  });

  it("no-op介入(interventionId: \"none\")ではpaired deltaが0になる", () => {
    const config: MonteCarloConfig = {
      baseSeed: 700,
      runs: 4,
      params: { ...DEFAULT_PARAMS, populationSize: 12, numLeaders: 1, overallWillingness: 0.5 },
      intervention: { interventionId: "none" },
      formation: classroomFormation({ minGroupSize: 3, maxGroupSize: 4 }),
    };

    const result = compareGroupFormation(config);

    expect(result.metrics.observerJoinerJoinRate.delta).toBe(0);
    expect(result.metrics.observerJoinerLeaveRate.delta).toBe(0);
    expect(result.metrics.groupFailureRate.delta).toBe(0);
    expect(result.metrics.lateJoinSuccessRate.delta).toBe(0);
    expect(result.metrics.averageJoinedCount.delta).toBe(0);
    expect(result.metrics.averageLeftCount.delta).toBe(0);
    expect(result.metrics.averageFirstGroupConfirmedTick.delta ?? 0).toBe(0);

    expect(result.groupFormationMetrics.unassignedCount.delta).toBe(0);
    expect(result.groupFormationMetrics.excessUnassignedCount.delta ?? 0).toBe(0);
    expect(result.groupFormationMetrics.averageMaxStress.delta).toBe(0);
    expect(result.groupFormationMetrics.averageJoinFailureCount.delta).toBe(0);
    expect(result.groupFormationMetrics.averageSearchRestartCount.delta).toBe(0);
    expect(result.groupFormationMetrics.interventionTriggerCount.delta).toBe(0);
    expect(result.groupFormationMetrics.recommendationAcceptedCount.delta).toBe(0);
    expect(result.groupFormationMetrics.teacherForcedAssignedCount.delta).toBe(0);
    expect(result.groupFormationMetrics.reassignedStudentCount.delta).toBe(0);
    expect(result.groupFormationMetrics.randomAssignedCount.delta).toBe(0);
    expect(result.processMetricsComparable).toBe(true);
  });

  it("random-assignment-baselineは過程指標が比較不能(processMetricsComparable: false)と明示される", () => {
    const config: MonteCarloConfig = {
      baseSeed: 900,
      runs: 3,
      params: { ...DEFAULT_PARAMS, populationSize: 12, numLeaders: 1, overallWillingness: 0.5 },
      intervention: { interventionId: "random-assignment-baseline" },
      formation: classroomFormation({ minGroupSize: 2, maxGroupSize: 2 }),
    };

    const result = compareGroupFormation(config);

    expect(result.processMetricsComparable).toBe(false);
    for (const run of result.intervention.groupFormationRuns) {
      expect(run.isRandomAssignmentBaseline).toBe(true);
      // ランダム割当は自由形成の接近・失敗・再探索を一切経ない(受入条件: 構造的に0)
      expect(run.populationAverages.averageApproachCount).toBe(0);
      expect(run.populationAverages.averageJoinFailureCount).toBe(0);
      expect(run.populationAverages.averageSearchRestartCount).toBe(0);
    }
    for (const run of result.baseline.groupFormationRuns) {
      expect(run.isRandomAssignmentBaseline).toBe(false);
    }
  });
});

describe("groupFormation.ts: 構造的未割当と超過未割当の区別", () => {
  it("固定2人ペアで、教師強制割当後の未割当が構造的floorちょうどになる(奇数人数)", () => {
    const config: MonteCarloConfig = {
      baseSeed: 1200,
      runs: 1,
      params: { ...DEFAULT_PARAMS, populationSize: 11, numLeaders: 1, overallWillingness: 0.5 },
      intervention: { interventionId: "teacher-deadline-assignment" },
      formation: classroomFormation({ minGroupSize: 2, maxGroupSize: 2 }, 30),
    };

    const result = runGroupFormationMonteCarlo(config);
    const run = result.groupFormationRuns[0];

    expect(run.formationConfig.minGroupSize).toBe(2);
    expect(run.formationConfig.maxGroupSize).toBe(2);
    expect(run.structuralUnassignedFloor).toBe(1);
    expect(run.unassignedCount).toBe(1);
    expect(run.excessUnassignedCount).toBe(0);
    expect(run.teacherUnassignableCount).toBe(1);
    // 締切時に未割当だった生徒(自然形成で入れなかった人数)のうち、この1人を除く全員を強制割当した
    expect(run.teacherForcedAssignedCount).toBeGreaterThan(0);
  });

  it("可変定員(3〜4人)でも超過未割当を数値として算出する", () => {
    const config: MonteCarloConfig = {
      baseSeed: 1300,
      runs: 2,
      params: { ...DEFAULT_PARAMS, populationSize: 14, numLeaders: 2, overallWillingness: 0.6 },
      intervention: { interventionId: "teacher-deadline-assignment" },
      formation: classroomFormation({ minGroupSize: 3, maxGroupSize: 4 }, 30),
    };

    const result = runGroupFormationMonteCarlo(config);
    for (const run of result.groupFormationRuns) {
      expect(run.structuralUnassignedFloor).toBeDefined();
      expect(run.excessUnassignedCount).toBeDefined();
      expect(run.unassignedCount - (run.structuralUnassignedFloor ?? 0)).toBe(run.excessUnassignedCount);
    }
  });
});

describe("groupFormation.ts: 介入副作用指標の集計", () => {
  it("teacher-recommendationの提示数は受諾数+拒否数と一致する", () => {
    const config: MonteCarloConfig = {
      baseSeed: 1500,
      runs: 5,
      params: { ...DEFAULT_PARAMS, populationSize: 13, numLeaders: 1, overallWillingness: 0.4 },
      intervention: { interventionId: "teacher-recommendation" },
      formation: classroomFormation({ minGroupSize: 2, maxGroupSize: 2 }, 60),
    };

    const result = runGroupFormationMonteCarlo(config);
    const totalPresented = result.groupFormationRuns.reduce((sum, run) => sum + run.recommendationPresentedCount, 0);
    const totalResolved = result.groupFormationRuns.reduce(
      (sum, run) => sum + run.recommendationAcceptedCount + run.recommendationDeclinedCount,
      0,
    );
    expect(totalResolved).toBe(totalPresented);
    expect(result.groupFormationSummary.averageRecommendationPresentedCount).toBeGreaterThanOrEqual(0);
    if (totalPresented > 0) {
      expect(result.groupFormationSummary.recommendationAcceptanceRate).toBeGreaterThanOrEqual(0);
      expect(result.groupFormationSummary.recommendationAcceptanceRate).toBeLessThanOrEqual(1);
    }
  });

  it("二次会シナリオでは介入副作用指標が常に0(学校介入・afterPartyが相互に漏れない)", () => {
    const config: MonteCarloConfig = {
      baseSeed: 1700,
      runs: 3,
      params: { ...DEFAULT_PARAMS, populationSize: 10 },
      intervention: { interventionId: "light-observer-invitation" },
    };

    const result = runGroupFormationMonteCarlo(config);
    for (const run of result.groupFormationRuns) {
      expect(run.interventionTriggerCount).toBe(0);
      expect(run.teacherForcedAssignedCount).toBe(0);
      expect(run.randomAssignedCount).toBe(0);
      expect(run.isRandomAssignmentBaseline).toBe(false);
      expect(run.recommendationPresentedCount).toBe(0);
    }
  });

  it("Monte Carlo集計に中央値(medianUnassignedCount/medianMaxStress)を含む", () => {
    const config: MonteCarloConfig = {
      baseSeed: 1900,
      runs: 6,
      params: { ...DEFAULT_PARAMS, populationSize: 12, numLeaders: 1, overallWillingness: 0.5 },
      intervention: { interventionId: "none" },
      formation: classroomFormation({ minGroupSize: 2, maxGroupSize: 2 }),
    };

    const result = runGroupFormationMonteCarlo(config);
    expect(Number.isFinite(result.groupFormationSummary.medianUnassignedCount)).toBe(true);
    expect(Number.isFinite(result.groupFormationSummary.medianMaxStress)).toBe(true);
    expect(result.groupFormationSummary.stillUnassignedAfterRunRate).toBeCloseTo(
      1 - result.groupFormationSummary.allAssignedRate,
    );
  });
});
