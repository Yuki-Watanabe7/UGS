import { useState } from "react";
import { compareSpeechEffects } from "../simulation/speechEffectsMonteCarlo";
import { getPresetById } from "../simulation/presets";
import { getInterventionById } from "../simulation/interventions";
import type { InterventionScenarioId } from "../simulation/interventions";
import type { SpeechEffectDimension } from "../simulation/speechEffects";
import type { SpeechEffectsComparisonResult, SimParams } from "../simulation/types";
import { isValidRunCount, MAX_RUNS, MIN_RUNS } from "./monteCarloPanelHelpers";
import {
  isSameSpeechEffectsComparisonCondition,
  type SpeechEffectsComparisonConditionSnapshot,
} from "./speechEffectsComparisonPanelHelpers";

type Props = {
  presetId: string;
  params: SimParams;
  seed: number;
  interventionId: InterventionScenarioId;
  singleSimRunning: boolean;
  onBeforeRun: () => void;
};

const DEFAULT_RUN_COUNT = 30;

const DIMENSION_LABEL: Record<SpeechEffectDimension, string> = {
  stress: "ストレス(greet)",
  attractiveness: "魅力度(welcome)",
  approachProbability: "接近確率(invite)",
  leaveThreshold: "離脱しきい値(decline)",
};

const DIMENSIONS: SpeechEffectDimension[] = ["approachProbability", "attractiveness", "stress", "leaveThreshold"];

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

function formatCorrection(value: number): string {
  return value.toFixed(3);
}

function formatCorrectionDelta(delta: number): string {
  return `${delta > 0 ? "+" : ""}${delta.toFixed(3)}`;
}

type MetricRowProps = {
  label: string;
  off: string;
  on: string;
  delta: string;
};

function MetricRow({ label, off, on, delta }: MetricRowProps) {
  return (
    <div className="intervention-comparison-row">
      <span>{label}</span>
      <span>{off}</span>
      <span>{on}</span>
      <span>{delta}</span>
    </div>
  );
}

export function SpeechEffectsComparisonPanel({
  presetId,
  params,
  seed,
  interventionId,
  singleSimRunning,
  onBeforeRun,
}: Props) {
  const [runCountInput, setRunCountInput] = useState(String(DEFAULT_RUN_COUNT));
  const [result, setResult] = useState<SpeechEffectsComparisonResult | null>(null);
  const [resultCondition, setResultCondition] = useState<SpeechEffectsComparisonConditionSnapshot | null>(null);
  const [resultPresetName, setResultPresetName] = useState("");
  const [resultInterventionName, setResultInterventionName] = useState("");
  const [resultRuns, setResultRuns] = useState(0);

  const runCount = Number(runCountInput);
  const runCountValid = isValidRunCount(runCount);

  const currentCondition: SpeechEffectsComparisonConditionSnapshot = {
    presetId,
    seed,
    params,
    interventionId,
    speechEffectsOff: { enabled: false },
    speechEffectsOn: { enabled: true },
  };
  const isStale =
    result !== null &&
    resultCondition !== null &&
    !isSameSpeechEffectsComparisonCondition(currentCondition, resultCondition);

  const handleRun = () => {
    if (!runCountValid) return;
    onBeforeRun();
    const comparison = compareSpeechEffects({
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
    <div className="panel monte-carlo-panel speech-effects-comparison-panel">
      <h2>発言効果ON/OFFの比較</h2>
      <p className="monte-carlo-note">
        現在のプリセット・パラメータ・介入({getInterventionById(interventionId).name})・baseSeedを固定したまま、
        Phase 3発言効果(発言の認知・解釈・状態への補正)だけをOFF/ONで切り替えて、同じseed列で比較します。
      </p>

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

      <button type="button" onClick={handleRun} disabled={!runCountValid}>
        発言効果OFF/ONを比較して実行（baseSeed {seed}〜）
      </button>

      {result === null ? (
        <p className="monte-carlo-empty">
          実行すると、発言効果「OFF」と「ON」を同一条件(プリセット・パラメータ・介入・baseSeed・実行回数)で比較できます。
        </p>
      ) : (
        <>
          <p className="monte-carlo-condition">
            条件: {resultPresetName} / 介入: {resultInterventionName} / baseSeed {result.off.config.baseSeed}〜
            {result.off.config.baseSeed + resultRuns - 1} ({resultRuns}回)
          </p>
          {isStale && (
            <p className="monte-carlo-stale">現在の条件と異なる結果です。再実行すると最新の条件で更新されます。</p>
          )}

          <section className="intervention-comparison-summary">
            <div className="intervention-comparison-row intervention-comparison-header">
              <span></span>
              <span>発言効果OFF</span>
              <span>発言効果ON</span>
              <span>差分</span>
            </div>
            <MetricRow
              label="observerJoiner参加率"
              off={formatRate(result.metrics.observerJoinerJoinRate.baseline)}
              on={formatRate(result.metrics.observerJoinerJoinRate.intervention)}
              delta={formatRateDelta(result.metrics.observerJoinerJoinRate.delta)}
            />
            <MetricRow
              label="observerJoiner離脱率"
              off={formatRate(result.metrics.observerJoinerLeaveRate.baseline)}
              on={formatRate(result.metrics.observerJoinerLeaveRate.intervention)}
              delta={formatRateDelta(result.metrics.observerJoinerLeaveRate.delta)}
            />
            <MetricRow
              label="グループ不成立率"
              off={formatRate(result.metrics.groupFailureRate.baseline)}
              on={formatRate(result.metrics.groupFailureRate.intervention)}
              delta={formatRateDelta(result.metrics.groupFailureRate.delta)}
            />
            <MetricRow
              label="平均グループ成立tick"
              off={formatOptionalTick(result.metrics.averageFirstGroupConfirmedTick.baseline)}
              on={formatOptionalTick(result.metrics.averageFirstGroupConfirmedTick.intervention)}
              delta={formatOptionalTickDelta(result.metrics.averageFirstGroupConfirmedTick.delta)}
            />
            <MetricRow
              label="後乗り成功率"
              off={formatRate(result.metrics.lateJoinSuccessRate.baseline)}
              on={formatRate(result.metrics.lateJoinSuccessRate.intervention)}
              delta={formatRateDelta(result.metrics.lateJoinSuccessRate.delta)}
            />
            <MetricRow
              label="平均参加人数"
              off={formatCount(result.metrics.averageJoinedCount.baseline)}
              on={formatCount(result.metrics.averageJoinedCount.intervention)}
              delta={formatCountDelta(result.metrics.averageJoinedCount.delta)}
            />
            <MetricRow
              label="平均帰宅人数"
              off={formatCount(result.metrics.averageLeftCount.baseline)}
              on={formatCount(result.metrics.averageLeftCount.intervention)}
              delta={formatCountDelta(result.metrics.averageLeftCount.delta)}
            />
          </section>

          <section className="intervention-comparison-summary speech-effects-phase3-summary">
            <h3>Phase 3固有指標</h3>
            <div className="intervention-comparison-row intervention-comparison-header">
              <span></span>
              <span>発言効果OFF</span>
              <span>発言効果ON</span>
              <span>差分</span>
            </div>
            <MetricRow
              label="observerJoiner発言認知率"
              off={formatRate(result.phase3Metrics.observerJoinerHeardSpeechRate.baseline)}
              on={formatRate(result.phase3Metrics.observerJoinerHeardSpeechRate.intervention)}
              delta={formatRateDelta(result.phase3Metrics.observerJoinerHeardSpeechRate.delta)}
            />
            <MetricRow
              label="解釈/効果が発生したrun率"
              off={formatRate(result.phase3Metrics.interpretationOrEffectRate.baseline)}
              on={formatRate(result.phase3Metrics.interpretationOrEffectRate.intervention)}
              delta={formatRateDelta(result.phase3Metrics.interpretationOrEffectRate.delta)}
            />
            <MetricRow
              label="状態遷移へ発言効果が寄与したrun率"
              off={formatRate(result.phase3Metrics.transitionInfluencedRate.baseline)}
              on={formatRate(result.phase3Metrics.transitionInfluencedRate.intervention)}
              delta={formatRateDelta(result.phase3Metrics.transitionInfluencedRate.delta)}
            />
            {DIMENSIONS.map((dimension) => (
              <MetricRow
                key={dimension}
                label={`平均累積補正: ${DIMENSION_LABEL[dimension]}`}
                off={formatCorrection(result.phase3Metrics.dimensionTotals[dimension].baseline)}
                on={formatCorrection(result.phase3Metrics.dimensionTotals[dimension].intervention)}
                delta={formatCorrectionDelta(result.phase3Metrics.dimensionTotals[dimension].delta)}
              />
            ))}
          </section>
        </>
      )}
    </div>
  );
}
