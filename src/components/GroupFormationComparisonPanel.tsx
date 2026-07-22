import { useState } from "react";
import { compareGroupFormation, runGroupFormationMonteCarlo } from "../simulation/groupFormation";
import { getPresetById } from "../simulation/presets";
import { getInterventionById } from "../simulation/interventions";
import type { InterventionScenarioId } from "../simulation/interventions";
import type { FormationRuntimeOptions } from "../simulation/formationPolicy";
import type {
  GroupFormationComparisonResult,
  GroupFormationMonteCarloResult,
  GroupFormationRunSummary,
  SimParams,
} from "../simulation/types";
import { isValidRunCount, MAX_RUNS, MIN_RUNS } from "./monteCarloPanelHelpers";
import type { ScenarioPresentation } from "../presentation/scenarioPresentation";

/**
 * Issue #160 (Phase 4): 学校route専用。「介入なし」と選択中の教師介入をpaired比較し(`compareGroupFormation`)、
 * 未割当削減とその副作用(stress・参加失敗・再探索・強制割当・再編等)を同時に確認できるようにする。
 * ランダム割当(`random-assignment-baseline`)は自由形成・教師介入とは性質が異なる比較基準のため、
 * 独立したセクションとして別枠表示する(#160本文「ランダム割当を…別の比較基準として表示する」)。
 */

type Props = {
  presetId: string;
  params: SimParams;
  seed: number;
  singleSimRunning: boolean;
  onBeforeRun: () => void;
  formation?: FormationRuntimeOptions;
  presentation: ScenarioPresentation;
};

const DEFAULT_RUN_COUNT = 30;
const NOT_APPLICABLE = "対象外";

function formatOptionalTick(value: number | undefined): string {
  return value === undefined ? "—" : value.toFixed(1);
}

function formatCount(value: number): string {
  return value.toFixed(1);
}

function formatOptionalCount(value: number | undefined): string {
  return value === undefined ? NOT_APPLICABLE : value.toFixed(1);
}

function formatCountDelta(delta: number): string {
  return `${delta > 0 ? "+" : ""}${delta.toFixed(1)}`;
}

function formatOptionalCountDelta(delta: number | undefined): string {
  return delta === undefined ? NOT_APPLICABLE : formatCountDelta(delta);
}

function aggregateGroupSizeDistribution(runs: GroupFormationRunSummary[]): Record<number, number> {
  const totals: Record<number, number> = {};
  for (const run of runs) {
    for (const [size, count] of Object.entries(run.groupSizeDistribution)) {
      totals[Number(size)] = (totals[Number(size)] ?? 0) + count;
    }
  }
  return totals;
}

function formatGroupSizeDistribution(distribution: Record<number, number>, unitWord: string): string {
  const entries = Object.entries(distribution)
    .map(([size, count]) => [Number(size), count] as const)
    .sort(([a], [b]) => a - b);
  if (entries.length === 0) return "—";
  return entries.map(([size, count]) => `${size}人${unitWord}:${count}`).join(" / ");
}

type MetricRowProps = {
  label: string;
  baseline: string;
  intervention: string;
  delta: string;
};

function MetricRow({ label, baseline, intervention, delta }: MetricRowProps) {
  return (
    <div className="intervention-comparison-row">
      <span>{label}</span>
      <span>{baseline}</span>
      <span>{intervention}</span>
      <span>{delta}</span>
    </div>
  );
}

export function GroupFormationComparisonPanel({
  presetId,
  params,
  seed,
  singleSimRunning,
  onBeforeRun,
  formation,
  presentation,
}: Props) {
  const unitWord = presentation.groupUnit?.unitWord ?? "班";

  const teacherInterventionIds = presentation.availableInterventionIds.filter((id) => {
    if (id === "none" || id === "random-assignment-baseline") return false;
    return getInterventionById(id).applicability.audience === "school";
  });
  const hasRandomBaseline = presentation.availableInterventionIds.includes("random-assignment-baseline");

  const [runCountInput, setRunCountInput] = useState(String(DEFAULT_RUN_COUNT));
  const [comparisonInterventionId, setComparisonInterventionId] = useState<InterventionScenarioId | "">(
    teacherInterventionIds[0] ?? "",
  );
  const [result, setResult] = useState<GroupFormationComparisonResult | null>(null);
  const [randomResult, setRandomResult] = useState<GroupFormationMonteCarloResult | null>(null);
  const [resultRuns, setResultRuns] = useState(0);
  const [resultInterventionName, setResultInterventionName] = useState("");

  const runCount = Number(runCountInput);
  const runCountValid = isValidRunCount(runCount);
  const canRun = runCountValid && comparisonInterventionId !== "";

  const handleRun = () => {
    if (!runCountValid || comparisonInterventionId === "") return;
    onBeforeRun();

    const comparison = compareGroupFormation({
      baseSeed: seed,
      runs: runCount,
      params,
      intervention: { interventionId: comparisonInterventionId },
      formation,
    });
    setResult(comparison);
    setResultRuns(runCount);
    setResultInterventionName(getInterventionById(comparisonInterventionId).name);

    if (hasRandomBaseline) {
      setRandomResult(
        runGroupFormationMonteCarlo({
          baseSeed: seed,
          runs: runCount,
          params,
          intervention: { interventionId: "random-assignment-baseline" },
          formation,
        }),
      );
    } else {
      setRandomResult(null);
    }
  };

  if (teacherInterventionIds.length === 0) {
    return null;
  }

  return (
    <div className="panel monte-carlo-panel intervention-comparison-panel group-formation-comparison-panel">
      <h2>介入なしとの比較(班形成・教師介入)</h2>

      <label className="field">
        <span>比較対象介入</span>
        <select
          value={comparisonInterventionId}
          onChange={(e) => setComparisonInterventionId(e.target.value as InterventionScenarioId)}
        >
          {teacherInterventionIds.map((id) => (
            <option key={id} value={id}>
              {getInterventionById(id).name}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>
          実行回数（{MIN_RUNS}〜{MAX_RUNS}）
        </span>
        <input
          type="number"
          min={MIN_RUNS}
          max={MAX_RUNS}
          value={runCountInput}
          onChange={(e) => setRunCountInput(e.target.value)}
        />
      </label>
      {!runCountValid && (
        <p className="monte-carlo-error">
          実行回数は{MIN_RUNS}〜{MAX_RUNS}の整数で指定してください。
        </p>
      )}

      {singleSimRunning && <p className="monte-carlo-note">実行すると、単発シミュレーションは一時停止します。</p>}

      <button type="button" onClick={handleRun} disabled={!canRun}>
        介入なしと比較して実行（baseSeed {seed}〜）
      </button>

      {result === null ? (
        <p className="monte-carlo-empty">
          実行すると、「介入なし」と選択した教師介入を同一条件(プリセット・パラメータ・baseSeed・実行回数)で
          paired比較できます。
        </p>
      ) : (
        <>
          <p className="monte-carlo-condition">
            条件: {getPresetById(presetId).name} / 介入: {resultInterventionName}(介入なしと比較) / baseSeed{" "}
            {seed}〜{seed + resultRuns - 1} ({resultRuns}回)
          </p>

          <section className="intervention-comparison-summary">
            <div className="intervention-comparison-row intervention-comparison-header">
              <span></span>
              <span>介入なし</span>
              <span>{resultInterventionName}</span>
              <span>差分</span>
            </div>
            <MetricRow
              label={`未割当人数(平均)`}
              baseline={formatCount(result.baseline.groupFormationSummary.averageUnassignedCount)}
              intervention={formatCount(result.intervention.groupFormationSummary.averageUnassignedCount)}
              delta={formatCountDelta(result.groupFormationMetrics.unassignedCount.delta)}
            />
            <MetricRow
              label="超過未割当人数(平均)"
              baseline={formatOptionalCount(result.baseline.groupFormationSummary.averageExcessUnassignedCount)}
              intervention={formatOptionalCount(result.intervention.groupFormationSummary.averageExcessUnassignedCount)}
              delta={formatOptionalCountDelta(result.groupFormationMetrics.excessUnassignedCount.delta)}
            />
            <MetricRow
              label="平均完了tick"
              baseline={formatOptionalTick(result.baseline.summary.averageFirstGroupConfirmedTick)}
              intervention={formatOptionalTick(result.intervention.summary.averageFirstGroupConfirmedTick)}
              delta={formatOptionalTick(result.metrics.averageFirstGroupConfirmedTick.delta)}
            />
            <MetricRow
              label="最大stress(平均)"
              baseline={formatCount(result.baseline.groupFormationSummary.averageMaxStress)}
              intervention={formatCount(result.intervention.groupFormationSummary.averageMaxStress)}
              delta={formatCountDelta(result.groupFormationMetrics.averageMaxStress.delta)}
            />
            <MetricRow
              label="参加失敗回数(平均)"
              baseline={formatCount(result.baseline.groupFormationSummary.averageJoinFailureCount)}
              intervention={formatCount(result.intervention.groupFormationSummary.averageJoinFailureCount)}
              delta={formatCountDelta(result.groupFormationMetrics.averageJoinFailureCount.delta)}
            />
            <MetricRow
              label="再探索回数(平均)"
              baseline={formatCount(result.baseline.groupFormationSummary.averageSearchRestartCount)}
              intervention={formatCount(result.intervention.groupFormationSummary.averageSearchRestartCount)}
              delta={formatCountDelta(result.groupFormationMetrics.averageSearchRestartCount.delta)}
            />
            <MetricRow
              label="介入発火回数(平均)"
              baseline={formatCount(result.baseline.groupFormationSummary.averageInterventionTriggerCount)}
              intervention={formatCount(result.intervention.groupFormationSummary.averageInterventionTriggerCount)}
              delta={formatCountDelta(result.groupFormationMetrics.interventionTriggerCount.delta)}
            />
            <MetricRow
              label="推薦受諾回数(平均)"
              baseline={formatCount(result.baseline.groupFormationSummary.averageRecommendationAcceptedCount)}
              intervention={formatCount(result.intervention.groupFormationSummary.averageRecommendationAcceptedCount)}
              delta={formatCountDelta(result.groupFormationMetrics.recommendationAcceptedCount.delta)}
            />
            <MetricRow
              label="教師強制割当人数(平均)"
              baseline={formatCount(result.baseline.groupFormationSummary.averageTeacherForcedAssignedCount)}
              intervention={formatCount(result.intervention.groupFormationSummary.averageTeacherForcedAssignedCount)}
              delta={formatCountDelta(result.groupFormationMetrics.teacherForcedAssignedCount.delta)}
            />
            <MetricRow
              label={`再編された${unitWord}の生徒数(平均)`}
              baseline={formatCount(result.baseline.groupFormationSummary.averageReassignedStudentCount)}
              intervention={formatCount(result.intervention.groupFormationSummary.averageReassignedStudentCount)}
              delta={formatCountDelta(result.groupFormationMetrics.reassignedStudentCount.delta)}
            />
          </section>

          <p className="monte-carlo-note">
            {unitWord}サイズ分布({resultInterventionName}、全run合算): {" "}
            {formatGroupSizeDistribution(
              aggregateGroupSizeDistribution(result.intervention.groupFormationRuns),
              unitWord,
            )}
          </p>

          {randomResult && (
            <section className="group-formation-random-baseline">
              <h3>[比較基準] {getInterventionById("random-assignment-baseline").name}</h3>
              <p className="monte-carlo-note">
                自由形成の過程(接近・参加失敗・再探索・stress蓄積)を一切経ないため、これらの指標は
                「介入なし」「{resultInterventionName}」とは直接比較できません({NOT_APPLICABLE})。
                割当・未割当の結果だけを比較基準として参照してください。
              </p>
              <section className="intervention-comparison-summary">
                <div className="intervention-comparison-row intervention-comparison-header">
                  <span></span>
                  <span>介入なし</span>
                  <span>ランダム割当</span>
                  <span>差分</span>
                </div>
                <MetricRow
                  label="未割当人数(平均)"
                  baseline={formatCount(result.baseline.groupFormationSummary.averageUnassignedCount)}
                  intervention={formatCount(randomResult.groupFormationSummary.averageUnassignedCount)}
                  delta={formatCountDelta(
                    randomResult.groupFormationSummary.averageUnassignedCount -
                      result.baseline.groupFormationSummary.averageUnassignedCount,
                  )}
                />
                <MetricRow
                  label="超過未割当人数(平均)"
                  baseline={formatOptionalCount(result.baseline.groupFormationSummary.averageExcessUnassignedCount)}
                  intervention={formatOptionalCount(randomResult.groupFormationSummary.averageExcessUnassignedCount)}
                  delta={
                    result.baseline.groupFormationSummary.averageExcessUnassignedCount === undefined ||
                    randomResult.groupFormationSummary.averageExcessUnassignedCount === undefined
                      ? NOT_APPLICABLE
                      : formatCountDelta(
                          randomResult.groupFormationSummary.averageExcessUnassignedCount -
                            result.baseline.groupFormationSummary.averageExcessUnassignedCount,
                        )
                  }
                />
                <MetricRow
                  label="ランダム割当人数(平均)"
                  baseline={NOT_APPLICABLE}
                  intervention={formatCount(randomResult.groupFormationSummary.averageRandomAssignedCount)}
                  delta={NOT_APPLICABLE}
                />
                <MetricRow
                  label="最大stress(平均)"
                  baseline={formatCount(result.baseline.groupFormationSummary.averageMaxStress)}
                  intervention={NOT_APPLICABLE}
                  delta={NOT_APPLICABLE}
                />
                <MetricRow
                  label="参加失敗・再探索回数(平均)"
                  baseline={`${formatCount(result.baseline.groupFormationSummary.averageJoinFailureCount)} / ${formatCount(result.baseline.groupFormationSummary.averageSearchRestartCount)}`}
                  intervention={NOT_APPLICABLE}
                  delta={NOT_APPLICABLE}
                />
              </section>
            </section>
          )}
        </>
      )}
    </div>
  );
}
