import { useState } from "react";
import { runMonteCarlo } from "../simulation/monteCarlo";
import { getPresetById } from "../simulation/presets";
import { getInterventionById } from "../simulation/interventions";
import type { InterventionScenarioId } from "../simulation/interventions";
import type { AgentState, MonteCarloResult, ObserverJoinerRunSummary, SimParams } from "../simulation/types";
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

const AGENT_STATE_LABEL: Record<AgentState, string> = {
  undecided: "未定",
  forming: "輪を形成中",
  approaching: "接近中",
  joined: "参加済み",
  leaving: "離脱中",
  left: "離脱済み",
  unassigned: "未割当",
};

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

export function MonteCarloPanel({ presetId, params, seed, interventionId, singleSimRunning, onBeforeRun }: Props) {
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
            条件: {resultPresetName} / 介入: {resultInterventionName} / baseSeed {result.config.baseSeed}〜
            {result.config.baseSeed + result.config.runs - 1} ({result.config.runs}回)
          </p>
          {isStale && (
            <p className="monte-carlo-stale">
              現在の条件と異なる結果です。再実行すると最新の条件で更新されます。
            </p>
          )}

          <section className="monte-carlo-summary">
            <div className="monte-carlo-summary-row">
              <span>observerJoiner参加率</span>
              <span>{formatRate(result.summary.observerJoinerJoinRate)}</span>
            </div>
            <div className="monte-carlo-summary-row">
              <span>observerJoiner離脱率</span>
              <span>{formatRate(result.summary.observerJoinerLeaveRate)}</span>
            </div>
            <div className="monte-carlo-summary-row">
              <span>グループ不成立率</span>
              <span>{formatRate(result.summary.groupFailureRate)}</span>
            </div>
            <div className="monte-carlo-summary-row">
              <span>平均グループ成立tick</span>
              <span>{formatOptionalTick(result.summary.averageFirstGroupConfirmedTick)}</span>
            </div>
            <div className="monte-carlo-summary-row">
              <span>後乗り成功率</span>
              <span>{formatRate(result.summary.lateJoinSuccessRate)}</span>
            </div>
            <div className="monte-carlo-summary-row">
              <span>平均参加人数</span>
              <span>{formatAverage(result.summary.averageJoinedCount)}</span>
            </div>
            <div className="monte-carlo-summary-row">
              <span>平均帰宅人数</span>
              <span>{formatAverage(result.summary.averageLeftCount)}</span>
            </div>
          </section>

          <section className="monte-carlo-runs">
            <h3>個別run一覧</h3>
            <div className="monte-carlo-runs-list">
              {result.runs.map((run) => (
                <div className="monte-carlo-run-row" key={run.seed}>
                  <span>seed {run.seed}</span>
                  <span>{summarizeObservers(run.summary.observerJoiners, (o) => AGENT_STATE_LABEL[o.finalState])}</span>
                  <span>{summarizeObservers(run.summary.observerJoiners, (o) => formatTick(o.joinedTick))}</span>
                  <span>{summarizeObservers(run.summary.observerJoiners, (o) => formatTick(o.leftTick))}</span>
                  <span>{formatTick(run.summary.firstGroupConfirmedTick)}</span>
                  <span>{run.summary.confirmedGroupCount}グループ</span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
