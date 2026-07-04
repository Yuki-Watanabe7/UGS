import { useState } from "react";
import { compareMonteCarloIntervention } from "../simulation/monteCarlo";
import { getPresetById } from "../simulation/presets";
import { getInterventionById } from "../simulation/interventions";
import type { InterventionScenarioId } from "../simulation/interventions";
import type { MonteCarloComparisonResult, SimParams } from "../simulation/types";
import { isSameCondition, isValidRunCount, MAX_RUNS, MIN_RUNS } from "./monteCarloPanelHelpers";
import type { RunConditionSnapshot } from "./monteCarloPanelHelpers";

type Props = {
  presetId: string;
  params: SimParams;
  seed: number;
  interventionId: InterventionScenarioId;
  singleSimRunning: boolean;
  onBeforeRun: () => void;
};

const DEFAULT_RUN_COUNT = 30;

function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatRateDelta(delta: number): string {
  const pt = delta * 100;
  return `${pt > 0 ? "+" : ""}${pt.toFixed(1)}pt`;
}

function formatOptionalTick(value: number | undefined): string {
  return value === undefined ? "—" : value.toFixed(1);
}

function formatOptionalTickDelta(delta: number | undefined): string {
  return delta === undefined ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(1)}tick`;
}

function formatCount(value: number): string {
  return value.toFixed(1);
}

function formatCountDelta(delta: number): string {
  return `${delta > 0 ? "+" : ""}${delta.toFixed(1)}人`;
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

export function InterventionComparisonPanel({
  presetId,
  params,
  seed,
  interventionId,
  singleSimRunning,
  onBeforeRun,
}: Props) {
  const [runCountInput, setRunCountInput] = useState(String(DEFAULT_RUN_COUNT));
  const [result, setResult] = useState<MonteCarloComparisonResult | null>(null);
  const [resultCondition, setResultCondition] = useState<RunConditionSnapshot | null>(null);
  const [resultPresetName, setResultPresetName] = useState("");
  const [resultInterventionName, setResultInterventionName] = useState("");
  const [resultRuns, setResultRuns] = useState(0);

  const runCount = Number(runCountInput);
  const runCountValid = isValidRunCount(runCount);
  const isNone = interventionId === "none";

  const currentCondition: RunConditionSnapshot = { presetId, seed, params, interventionId };
  const isStale = result !== null && resultCondition !== null && !isSameCondition(currentCondition, resultCondition);

  const handleRun = () => {
    if (!runCountValid || isNone) return;
    onBeforeRun();
    const comparison = compareMonteCarloIntervention({
      baseSeed: seed,
      runs: runCount,
      params,
      intervention: { interventionId },
    });
    setResult(comparison);
    setResultCondition(currentCondition);
    setResultPresetName(getPresetById(presetId).name);
    setResultInterventionName(getInterventionById(interventionId).name);
    setResultRuns(runCount);
  };

  return (
    <div className="panel monte-carlo-panel intervention-comparison-panel">
      <h2>介入なしとの比較</h2>

      {isNone ? (
        <p className="monte-carlo-empty">
          「介入なし」が選択されているため比較できません。介入シナリオを選択すると、介入なしとの差分をここで確認できます。
        </p>
      ) : (
        <>
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

          {singleSimRunning && (
            <p className="monte-carlo-note">実行すると、単発シミュレーションは一時停止します。</p>
          )}

          <button type="button" onClick={handleRun} disabled={!runCountValid}>
            介入なしと比較して実行（baseSeed {seed}〜）
          </button>

          {result === null ? (
            <p className="monte-carlo-empty">
              実行すると、「介入なし」と「{getInterventionById(interventionId).name}」を同一条件(プリセット・
              パラメータ・baseSeed・実行回数)で比較できます。
            </p>
          ) : (
            <>
              <p className="monte-carlo-condition">
                条件: {resultPresetName} / 介入: {resultInterventionName}(介入なしと比較) / baseSeed{" "}
                {result.baseline.config.baseSeed}〜{result.baseline.config.baseSeed + resultRuns - 1} ({resultRuns}回)
              </p>
              {isStale && (
                <p className="monte-carlo-stale">
                  現在の条件と異なる結果です。再実行すると最新の条件で更新されます。
                </p>
              )}

              <section className="intervention-comparison-summary">
                <div className="intervention-comparison-row intervention-comparison-header">
                  <span></span>
                  <span>介入なし</span>
                  <span>{resultInterventionName}</span>
                  <span>差分</span>
                </div>
                <MetricRow
                  label="observerJoiner参加率"
                  baseline={formatRate(result.metrics.observerJoinerJoinRate.baseline)}
                  intervention={formatRate(result.metrics.observerJoinerJoinRate.intervention)}
                  delta={formatRateDelta(result.metrics.observerJoinerJoinRate.delta)}
                />
                <MetricRow
                  label="observerJoiner離脱率"
                  baseline={formatRate(result.metrics.observerJoinerLeaveRate.baseline)}
                  intervention={formatRate(result.metrics.observerJoinerLeaveRate.intervention)}
                  delta={formatRateDelta(result.metrics.observerJoinerLeaveRate.delta)}
                />
                <MetricRow
                  label="グループ不成立率"
                  baseline={formatRate(result.metrics.groupFailureRate.baseline)}
                  intervention={formatRate(result.metrics.groupFailureRate.intervention)}
                  delta={formatRateDelta(result.metrics.groupFailureRate.delta)}
                />
                <MetricRow
                  label="平均グループ成立tick"
                  baseline={formatOptionalTick(result.metrics.averageFirstGroupConfirmedTick.baseline)}
                  intervention={formatOptionalTick(result.metrics.averageFirstGroupConfirmedTick.intervention)}
                  delta={formatOptionalTickDelta(result.metrics.averageFirstGroupConfirmedTick.delta)}
                />
                <MetricRow
                  label="後乗り成功率"
                  baseline={formatRate(result.metrics.lateJoinSuccessRate.baseline)}
                  intervention={formatRate(result.metrics.lateJoinSuccessRate.intervention)}
                  delta={formatRateDelta(result.metrics.lateJoinSuccessRate.delta)}
                />
                <MetricRow
                  label="平均参加人数"
                  baseline={formatCount(result.metrics.averageJoinedCount.baseline)}
                  intervention={formatCount(result.metrics.averageJoinedCount.intervention)}
                  delta={formatCountDelta(result.metrics.averageJoinedCount.delta)}
                />
                <MetricRow
                  label="平均帰宅人数"
                  baseline={formatCount(result.metrics.averageLeftCount.baseline)}
                  intervention={formatCount(result.metrics.averageLeftCount.intervention)}
                  delta={formatCountDelta(result.metrics.averageLeftCount.delta)}
                />
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
