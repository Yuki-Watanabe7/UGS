import type {
  GroupFormationComparisonResult,
  GroupFormationMonteCarloResult,
  GroupFormationMonteCarloSummary,
  GroupFormationRunSummary,
  InterventionEffectMetrics,
  MonteCarloConfig,
  MonteCarloRunResult,
  SimParams,
  SimulationEventType,
  SimulationState,
} from "./types";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { getFormationPolicyById, resolveNominalGroupCapacity } from "./formationPolicy";
import { buildPairFormationRunSummary, summarizePairFormationRuns } from "./pairFormation";
import { buildSimulationSummary } from "./summary";
import { DEFAULT_MAX_TICKS, metricDelta, optionalMetricDelta, summarizeRuns } from "./monteCarlo";

/**
 * Issue #160 (Phase 4): 学校向け教師介入・班人数比較のための一般化レイヤー。`pairFormation.ts`
 * (Issue #136、ペア専用の名前が残る)を直接書き換えず、その上に一般化した名前(`confirmedGroupCount`等)
 * と、教師介入(推薦・強制割当・再配分・ランダム割当)の副作用指標を積み増す。既存の
 * `pairFormation.ts`/`monteCarlo.ts`の挙動・テストには一切影響しない(非破壊的な追加レイヤー)。
 */

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function rateOf(values: boolean[]): number {
  if (values.length === 0) return 0;
  return values.filter(Boolean).length / values.length;
}

function countEvents(log: SimulationState["log"], eventType: SimulationEventType): number {
  return log.filter((entry) => entry.eventType === eventType).length;
}

function lastEventMetadata(log: SimulationState["log"], eventType: SimulationEventType) {
  return log.filter((entry) => entry.eventType === eventType).at(-1)?.metadata;
}

/**
 * `state.log`の教師介入・ランダム割当関連の構造化イベント(Issue #156/#157/#158/#159で追加済み)から、
 * run単位の副作用指標を集計する。`teacherAssignmentCompleted`/`randomAssignmentCompleted`は
 * run中に高々1回しか記録されないため(それぞれ`onAtDeadline`/`onInitialState`で1回のみ発火)、
 * 最後の(=唯一の)イベントのmetadataをそのまま集計値として使ってよい。
 */
function buildInterventionEffectMetrics(state: SimulationState, assignedCount: number): InterventionEffectMetrics {
  const log = state.log;
  const teacherCompleted = lastEventMetadata(log, "teacherAssignmentCompleted");
  const randomCompleted = lastEventMetadata(log, "randomAssignmentCompleted");

  const teacherForcedAssignedCount = teacherCompleted?.assignedByStrategyCount ?? 0;
  const reassignedGroupCount = teacherCompleted?.rebalancedGroupCount ?? 0;
  const reassignedStudentCount = teacherCompleted?.rebalancedStudentCount ?? 0;
  const teacherUnassignableCount = teacherCompleted?.structuralUnassignedCount ?? 0;

  const randomAssignedCount = randomCompleted?.assignedByStrategyCount ?? 0;
  const randomUnassignableCount = randomCompleted?.structuralUnassignedCount ?? 0;

  const isRandomAssignmentBaseline = countEvents(log, "randomAssignmentStarted") > 0;
  const interventionAssignedCount = teacherForcedAssignedCount + randomAssignedCount;

  return {
    interventionTriggerCount: countEvents(log, "schoolInterventionTriggered"),
    anonymousHelpRequestedCount: countEvents(log, "anonymousHelpRequested"),
    recommendationPresentedCount: countEvents(log, "teacherRecommendationIssued"),
    recommendationAcceptedCount: countEvents(log, "teacherRecommendationAccepted"),
    recommendationDeclinedCount: countEvents(log, "teacherRecommendationDeclined"),
    recommendationUnavailableCount: countEvents(log, "teacherRecommendationUnavailable"),
    teacherForcedAssignedCount,
    reassignedGroupCount,
    reassignedStudentCount,
    teacherUnassignableCount,
    randomAssignedCount,
    randomUnassignableCount,
    isRandomAssignmentBaseline,
    interventionAssignedCount,
    naturalAssignedCount: Math.max(0, assignedCount - interventionAssignedCount),
  };
}

/**
 * `buildPairFormationRunSummary`(#136)を土台に、一般化フィールド(`confirmedGroupCount`等、
 * `PairFormationRunSummary`の既存フィールドと同値)・形成設定のスナップショット・介入副作用指標を
 * 積み増した単発runサマリーを導出する。`SimulationState`はmutationしない。
 */
export function buildGroupFormationRunSummary(state: SimulationState, params: SimParams): GroupFormationRunSummary {
  const pairSummary = buildPairFormationRunSummary(state, params);
  const interventionEffects = buildInterventionEffectMetrics(state, pairSummary.assignedCount);

  const formationPolicy = getFormationPolicyById(
    state.formationScenarioId ?? "afterParty",
    state.formationDeadlineTick,
    state.formationClassroomGroupSize,
  );
  const capacity = resolveNominalGroupCapacity(formationPolicy, params);

  return {
    ...pairSummary,
    ...interventionEffects,
    confirmedGroupCount: pairSummary.confirmedPairCount,
    firstGroupConfirmedTick: pairSummary.firstPairConfirmedTick,
    lastGroupConfirmedTick: pairSummary.lastPairConfirmedTick,
    sameCliqueGroupRate: pairSummary.sameCliquePairRate,
    crossCliqueGroupRate: pairSummary.crossCliquePairRate,
    formationConfig: {
      minGroupSize: capacity.minGroupSize,
      maxGroupSize: capacity.maxGroupSize,
      deadlineTick: state.formationDeadlineTick,
      populationSize: state.agents.length,
    },
  };
}

/**
 * `runs`(既存の主要指標)と`groupFormationRuns`(`runs`と同じ順序・同じ長さ)から、一般化された
 * Monte Carlo集計値を導出する。`summarizePairFormationRuns`をそのまま再利用しつつ、中央値
 * (#160本文「平均だけでなく、少なくとも中央値または分位点を表示する」)と介入副作用指標の集計を追加する。
 */
export function summarizeGroupFormationRuns(
  runs: MonteCarloRunResult[],
  groupFormationRuns: GroupFormationRunSummary[],
): GroupFormationMonteCarloSummary {
  const pairSummary = summarizePairFormationRuns(runs, groupFormationRuns);

  const totalPresented = groupFormationRuns.reduce((sum, run) => sum + run.recommendationPresentedCount, 0);
  const totalAccepted = groupFormationRuns.reduce((sum, run) => sum + run.recommendationAcceptedCount, 0);
  const recommendationAcceptanceRate = totalPresented === 0 ? undefined : totalAccepted / totalPresented;

  const maxStressAverages = groupFormationRuns.map((run) => run.populationAverages.averageMaxStress);
  const unassignedCounts = groupFormationRuns.map((run) => run.unassignedCount);

  return {
    ...pairSummary,
    medianUnassignedCount: median(unassignedCounts),
    averageMaxStress: average(maxStressAverages),
    medianMaxStress: median(maxStressAverages),
    stillUnassignedAfterRunRate: 1 - pairSummary.allAssignedRate,
    averageInterventionTriggerCount: average(groupFormationRuns.map((run) => run.interventionTriggerCount)),
    averageAnonymousHelpRequestedCount: average(groupFormationRuns.map((run) => run.anonymousHelpRequestedCount)),
    averageRecommendationPresentedCount: average(groupFormationRuns.map((run) => run.recommendationPresentedCount)),
    averageRecommendationAcceptedCount: average(groupFormationRuns.map((run) => run.recommendationAcceptedCount)),
    recommendationAcceptanceRate,
    averageTeacherForcedAssignedCount: average(groupFormationRuns.map((run) => run.teacherForcedAssignedCount)),
    forcedAssignmentRate: rateOf(groupFormationRuns.map((run) => run.teacherForcedAssignedCount > 0)),
    averageReassignedGroupCount: average(groupFormationRuns.map((run) => run.reassignedGroupCount)),
    averageReassignedStudentCount: average(groupFormationRuns.map((run) => run.reassignedStudentCount)),
    reassignmentRate: rateOf(groupFormationRuns.map((run) => run.reassignedGroupCount > 0)),
    averageRandomAssignedCount: average(groupFormationRuns.map((run) => run.randomAssignedCount)),
    randomAssignmentBaselineRunRate: rateOf(groupFormationRuns.map((run) => run.isRandomAssignmentBaseline)),
  };
}

function runGroupFormationSingle(
  seed: number,
  params: SimParams,
  maxTicks: number,
  intervention: MonteCarloConfig["intervention"],
  formation: MonteCarloConfig["formation"],
): { runResult: MonteCarloRunResult; groupFormationRunSummary: GroupFormationRunSummary } {
  const rng = new SeededRandom(seed);
  let state = createInitialState(seed, params, intervention, undefined, undefined, undefined, undefined, formation);
  while (!state.finished && state.tick < maxTicks) {
    state = stepSimulation(state, params, rng, intervention, undefined, undefined, undefined, undefined, formation);
  }

  const summary = buildSimulationSummary(state);
  const finishedTick = summary.finishedTick ?? state.tick;
  const groupFormationRunSummary = buildGroupFormationRunSummary(state, params);

  return { runResult: { seed, summary, finishedTick }, groupFormationRunSummary };
}

/**
 * `runMonteCarlo`と同じ実行(同一seed列)を行い、一般化されたグループ形成過程・介入副作用の集計
 * (`GroupFormationRunSummary`/`GroupFormationMonteCarloSummary`)を返す単一条件のMonte Carlo実行。
 */
export function runGroupFormationMonteCarlo(config: MonteCarloConfig): GroupFormationMonteCarloResult {
  const { baseSeed, runs: runCount, params, maxTicks, intervention, formation } = config;
  const resolvedMaxTicks = maxTicks ?? DEFAULT_MAX_TICKS;

  const runs: MonteCarloRunResult[] = [];
  const groupFormationRuns: GroupFormationRunSummary[] = [];
  for (let index = 0; index < runCount; index++) {
    const seed = baseSeed + index;
    const { runResult, groupFormationRunSummary } = runGroupFormationSingle(
      seed,
      params,
      resolvedMaxTicks,
      intervention,
      formation,
    );
    runs.push(runResult);
    groupFormationRuns.push(groupFormationRunSummary);
  }

  return {
    config,
    runs,
    summary: summarizeRuns(runs),
    groupFormationRuns,
    groupFormationSummary: summarizeGroupFormationRuns(runs, groupFormationRuns),
  };
}

/**
 * 選択中の介入(`config.intervention`)と、介入なし(baseline、常に`interventionId: "none"`)を、
 * 同一の`presetId`由来`params`・`formation`・`baseSeed`・`runs`・`maxTicks`でpaired比較する
 * (`compareMonteCarloIntervention`と同じseed列の対応の考え方に、グループ形成過程の負担・介入の
 * 副作用指標のdeltaを追加する)。`config.intervention.interventionId === "random-assignment-baseline"`
 * の場合、`processMetricsComparable: false`を返し、接近・参加失敗・再探索・stress系の指標は
 * 「0」ではなく比較不能であることを呼び出し側(UI)が明示できるようにする。
 */
export function compareGroupFormation(config: MonteCarloConfig): GroupFormationComparisonResult {
  const baseline = runGroupFormationMonteCarlo({ ...config, intervention: { interventionId: "none" } });
  const intervention = runGroupFormationMonteCarlo(config);

  const pairedSeeds = baseline.runs.map((run) => run.seed);
  const processMetricsComparable = config.intervention?.interventionId !== "random-assignment-baseline";

  return {
    baseline,
    intervention,
    pairedSeeds,
    processMetricsComparable,
    metrics: {
      observerJoinerJoinRate: metricDelta(
        baseline.summary.observerJoinerJoinRate,
        intervention.summary.observerJoinerJoinRate,
      ),
      observerJoinerLeaveRate: metricDelta(
        baseline.summary.observerJoinerLeaveRate,
        intervention.summary.observerJoinerLeaveRate,
      ),
      groupFailureRate: metricDelta(baseline.summary.groupFailureRate, intervention.summary.groupFailureRate),
      averageFirstGroupConfirmedTick: optionalMetricDelta(
        baseline.summary.averageFirstGroupConfirmedTick,
        intervention.summary.averageFirstGroupConfirmedTick,
      ),
      lateJoinSuccessRate: metricDelta(
        baseline.summary.lateJoinSuccessRate,
        intervention.summary.lateJoinSuccessRate,
      ),
      averageJoinedCount: metricDelta(baseline.summary.averageJoinedCount, intervention.summary.averageJoinedCount),
      averageLeftCount: metricDelta(baseline.summary.averageLeftCount, intervention.summary.averageLeftCount),
    },
    groupFormationMetrics: {
      unassignedCount: metricDelta(
        baseline.groupFormationSummary.averageUnassignedCount,
        intervention.groupFormationSummary.averageUnassignedCount,
      ),
      excessUnassignedCount: optionalMetricDelta(
        baseline.groupFormationSummary.averageExcessUnassignedCount,
        intervention.groupFormationSummary.averageExcessUnassignedCount,
      ),
      averageMaxStress: metricDelta(
        baseline.groupFormationSummary.averageMaxStress,
        intervention.groupFormationSummary.averageMaxStress,
      ),
      averageJoinFailureCount: metricDelta(
        baseline.groupFormationSummary.averageJoinFailureCount,
        intervention.groupFormationSummary.averageJoinFailureCount,
      ),
      averageSearchRestartCount: metricDelta(
        baseline.groupFormationSummary.averageSearchRestartCount,
        intervention.groupFormationSummary.averageSearchRestartCount,
      ),
      interventionTriggerCount: metricDelta(
        baseline.groupFormationSummary.averageInterventionTriggerCount,
        intervention.groupFormationSummary.averageInterventionTriggerCount,
      ),
      recommendationAcceptedCount: metricDelta(
        baseline.groupFormationSummary.averageRecommendationAcceptedCount,
        intervention.groupFormationSummary.averageRecommendationAcceptedCount,
      ),
      teacherForcedAssignedCount: metricDelta(
        baseline.groupFormationSummary.averageTeacherForcedAssignedCount,
        intervention.groupFormationSummary.averageTeacherForcedAssignedCount,
      ),
      reassignedStudentCount: metricDelta(
        baseline.groupFormationSummary.averageReassignedStudentCount,
        intervention.groupFormationSummary.averageReassignedStudentCount,
      ),
      randomAssignedCount: metricDelta(
        baseline.groupFormationSummary.averageRandomAssignedCount,
        intervention.groupFormationSummary.averageRandomAssignedCount,
      ),
    },
  };
}
