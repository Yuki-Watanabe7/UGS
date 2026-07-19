import { useState } from "react";
import { runMonteCarlo } from "../simulation/monteCarlo";
import { getPresetById } from "../simulation/presets";
import { getInterventionById } from "../simulation/interventions";
import type { InterventionScenarioId } from "../simulation/interventions";
import type { MonteCarloResult, ObserverJoinerRunSummary, SimParams } from "../simulation/types";
import { isSameCondition, isValidRunCount, MAX_RUNS, MIN_RUNS } from "./monteCarloPanelHelpers";
import type { RunConditionSnapshot } from "./monteCarloPanelHelpers";
import type { FormationRuntimeOptions } from "../simulation/formationPolicy";
import {
  AFTER_PARTY_PRESENTATION,
  type ScenarioPresentation,
} from "../presentation/scenarioPresentation";

type Props = {
  presetId: string;
  params: SimParams;
  seed: number;
  interventionId: InterventionScenarioId;
  singleSimRunning: boolean;
  onBeforeRun: () => void;
  formation?: FormationRuntimeOptions;
  presentation?: ScenarioPresentation;
};

const DEFAULT_RUN_COUNT = 30;

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function formatAverage(value: number): string {
  return value.toFixed(1);
}

function formatOptionalTick(value: number | undefined): string {
  return value === undefined ? "—" : value.toFixed(1);
}

function formatTick(value: number | undefined): string {
  return value === undefined ? "—" : `tick ${value}`;
}

function summarizeObservers(
  observers: ObserverJoinerRunSummary[],
  render: (observer: ObserverJoinerRunSummary) => string,
): string {
  if (observers.length === 0) return "—";
  return observers.map(render).join(" / ");
}

export function MonteCarloPanel({
  presetId,
  params,
  seed,
  interventionId,
  singleSimRunning,
  onBeforeRun,
  formation,
  presentation = AFTER_PARTY_PRESENTATION,
}: Props) {
  const [runCountInput, setRunCountInput] = useState(String(DEFAULT_RUN_COUNT));
  const [result, setResult] = useState<MonteCarloResult | null>(null);
  const [resultCondition, setResultCondition] = useState<RunConditionSnapshot | null>(null);
  const [resultPresetName, setResultPresetName] = useState("");
  const [resultInterventionName, setResultInterventionName] = useState("");

  const runCount = Number(runCountInput);
  const runCountValid = isValidRunCount(runCount);

  const currentCondition: RunConditionSnapshot = { presetId, seed, params, interventionId };
  const isStale = result !== null && resultCondition !== null && !isSameCondition(currentCondition, resultCondition);

  const handleRun = () => {
    if (!runCountValid) return;
    onBeforeRun();
    const monteCarloResult = runMonteCarlo({
      baseSeed: seed,
      runs: runCount,
      params,
      intervention: { interventionId },
      formation,
    });
    setResult(monteCarloResult);
    setResultCondition(currentCondition);
    setResultPresetName(getPresetById(presetId).name);
    setResultInterventionName(getInterventionById(interventionId).name);
  };

  return (
    <div className="panel monte-carlo-panel">
      <h2>Monte Carlo実行</h2>

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
        {runCountInput}回実行（baseSeed {seed}〜）
      </button>

      {result === null ? (
        <p className="monte-carlo-empty">
          現在の条件でMonte Carloを実行すると、確率的傾向を確認できます。
        </p>
      ) : (
        <>
          <p className="monte-carlo-condition">
            条件: {resultPresetName}
            {presentation.showInterventionControls ? ` / 介入: ${resultInterventionName}` : ""} / baseSeed {result.config.baseSeed}〜
            {result.config.baseSeed + result.config.runs - 1} ({result.config.runs}回)
          </p>
          {isStale && (
            <p className="monte-carlo-stale">
              現在の条件と異なる結果です。再実行すると最新の条件で更新されます。
            </p>
          )}

          <section className="monte-carlo-summary">
            <div className="monte-carlo-summary-row">
              <span>{presentation.monteCarlo.observerJoinRate}</span>
              <span>{formatRate(result.summary.observerJoinerJoinRate)}</span>
            </div>
            {presentation.monteCarlo.showLeaveMetrics && (
              <div className="monte-carlo-summary-row">
                <span>{presentation.monteCarlo.observerLeaveRate}</span>
                <span>{formatRate(result.summary.observerJoinerLeaveRate)}</span>
              </div>
            )}
            <div className="monte-carlo-summary-row">
              <span>{presentation.monteCarlo.groupFailureRate}</span>
              <span>{formatRate(result.summary.groupFailureRate)}</span>
            </div>
            <div className="monte-carlo-summary-row">
              <span>{presentation.monteCarlo.averageFirstConfirmedTick}</span>
              <span>{formatOptionalTick(result.summary.averageFirstGroupConfirmedTick)}</span>
            </div>
            {presentation.monteCarlo.showLateJoinMetric && (
              <div className="monte-carlo-summary-row">
                <span>{presentation.monteCarlo.lateJoinSuccessRate}</span>
                <span>{formatRate(result.summary.lateJoinSuccessRate)}</span>
              </div>
            )}
            <div className="monte-carlo-summary-row">
              <span>{presentation.monteCarlo.averageJoinedCount}</span>
              <span>{formatAverage(result.summary.averageJoinedCount)}</span>
            </div>
            {presentation.monteCarlo.showLeaveMetrics && (
              <div className="monte-carlo-summary-row">
                <span>{presentation.monteCarlo.averageLeftCount}</span>
                <span>{formatAverage(result.summary.averageLeftCount)}</span>
              </div>
            )}
          </section>

          <section className="monte-carlo-runs">
            <h3>個別run一覧</h3>
            <div className="monte-carlo-runs-list">
              {result.runs.map((run) => (
                <div className="monte-carlo-run-row" key={run.seed}>
                  <span>seed {run.seed}</span>
                  <span>
                    {summarizeObservers(
                      run.summary.observerJoiners,
                      (o) => presentation.agentStateLabels[o.finalState],
                    )}
                  </span>
                  <span>{summarizeObservers(run.summary.observerJoiners, (o) => formatTick(o.joinedTick))}</span>
                  <span>{summarizeObservers(run.summary.observerJoiners, (o) => formatTick(o.leftTick))}</span>
                  <span>{formatTick(run.summary.firstGroupConfirmedTick)}</span>
                  <span>{run.summary.confirmedGroupCount}{presentation.monteCarlo.confirmedUnit}</span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
