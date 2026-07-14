import type {
  MonteCarloRunResult,
  Phase4ComparisonResult,
  Phase4MonteCarloConfig,
  Phase4MonteCarloResult,
  Phase4MonteCarloSummary,
  Phase4RunSummary,
  SimParams,
} from "./types";
import type { InterventionRuntimeOptions } from "./interventions";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { buildPhase4RunSummary, buildSimulationSummary } from "./summary";
import { DEFAULT_MAX_TICKS, metricDelta, optionalMetricDelta, summarizeRuns } from "./monteCarlo";

/**
 * Issue #120: Phase 4モデル(socialExpression・speechTrust・relationshipTieをまとめて切り替える)の
 * ON/OFF paired比較。`speechEffectsMonteCarlo.ts`(Issue #99)のパターンを踏襲する。
 *
 * paired性の根拠: `socialExpression.ts`/`speechTrust.ts`/`relationshipTie.ts`の各`derive*`関数は
 * いずれも`rng`を読み取らない(乖離判定・真実性・trust更新・tie補正はすべて距離・性格パラメータ・
 * 現在stateからの決定的な計算のみで、確率的な要素を持たない)ため、これら3設定の`enabled`値は
 * SeededRandomの消費順序に一切影響しない。よってoff/on同じseedのrunは、Phase 4の判定・補正が
 * 実際にengine.tsの計算式(発言intent選択・解釈のtrust/relFactor係数・attractivenessのtie補正)へ
 * 加算される分だけが異なり、それ以外の乱数選択は完全に同じ列をたどる
 * (`docs/social-expression-phase4-boundary.md`/`docs/speech-trust-model.md`/
 * `docs/relationship-tie-model.md`参照)。
 *
 * speechEffects(Phase 3)はoff/on両条件とも有効固定にする: Phase 4の観測(trust更新・tie補正)は
 * いずれもPhase 3の認知記録(`SpeechReceptionEvent`)を前提とするため、speechEffects自体が無効だと
 * Phase 4をONにしても観測・更新が一切発生せず、比較として無意味になる
 * (`docs/speech-trust-model.md`/`docs/relationship-tie-model.md`の「config ON時」の記載を参照)。
 */
function runSingleCondition(
  seed: number,
  params: SimParams,
  enabled: boolean,
  maxTicks: number,
  intervention: InterventionRuntimeOptions | undefined,
): { runResult: MonteCarloRunResult; phase4RunSummary: Phase4RunSummary } {
  const rng = new SeededRandom(seed);
  const speechEffects = { enabled: true };
  const socialExpression = { enabled };
  const speechTrust = { enabled };
  const relationshipTie = { enabled };
  let state = createInitialState(seed, params, intervention, speechEffects, socialExpression, speechTrust, relationshipTie);
  while (!state.finished && state.tick < maxTicks) {
    state = stepSimulation(state, params, rng, intervention, speechEffects, socialExpression, speechTrust, relationshipTie);
  }

  const summary = buildSimulationSummary(state);
  const finishedTick = summary.finishedTick ?? state.tick;
  const phase4RunSummary = buildPhase4RunSummary(state);

  return { runResult: { seed, summary, finishedTick }, phase4RunSummary };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** `runs`からPhase 4固有指標を集計する。既存指標(`summarizeRuns`)・Phase 3固有指標とは独立した集計軸 */
export function summarizePhase4Runs(runs: Phase4RunSummary[]): Phase4MonteCarloSummary {
  return {
    runs: runs.length,
    averageDivergenceCount: average(runs.map((run) => run.divergenceCount)),
    averageExpressedSpeechCount: average(runs.map((run) => run.expressedSpeechCount)),
    averageTrustChangeAmount: average(runs.map((run) => run.trustChangeAmount)),
    averageTieChangeAmount: average(runs.map((run) => run.tieChangeAmount)),
  };
}

/**
 * 単一条件(Phase 4 off/onのいずれか)で`config.runs`回分のseedを実行する。既存指標は`summarizeRuns`
 * (`monteCarlo.ts`)をそのまま再利用し、Phase 4固有指標は`summarizePhase4Runs`で別途集計する。
 */
export function runPhase4MonteCarlo(config: Phase4MonteCarloConfig, enabled: boolean): Phase4MonteCarloResult {
  const { baseSeed, runs: runCount, params, maxTicks, intervention } = config;
  const resolvedMaxTicks = maxTicks ?? DEFAULT_MAX_TICKS;

  const runs: MonteCarloRunResult[] = [];
  const phase4Runs: Phase4RunSummary[] = [];
  for (let index = 0; index < runCount; index++) {
    const seed = baseSeed + index;
    const { runResult, phase4RunSummary } = runSingleCondition(seed, params, enabled, resolvedMaxTicks, intervention);
    runs.push(runResult);
    phase4Runs.push(phase4RunSummary);
  }

  return {
    config,
    runs,
    summary: summarizeRuns(runs),
    phase4Runs,
    phase4Summary: summarizePhase4Runs(phase4Runs),
  };
}

/**
 * 同一`presetId`由来`params`・`intervention`・`baseSeed`・`runs`・`maxTicks`で、Phase 4モデルoff
 * (`socialExpression`/`speechTrust`/`relationshipTie`すべて`enabled: false`)とon(すべて`true`)を
 * 実行し、既存の主要指標とPhase 4固有指標の両方について差分を返す。run i同士は`baseSeed + i`で
 * 1:1に対応する(paired比較)。
 */
export function comparePhase4Model(config: Phase4MonteCarloConfig): Phase4ComparisonResult {
  const off = runPhase4MonteCarlo(config, false);
  const on = runPhase4MonteCarlo(config, true);

  const pairedSeeds = off.runs.map((run) => run.seed);

  return {
    off,
    on,
    pairedSeeds,
    metrics: {
      observerJoinerJoinRate: metricDelta(off.summary.observerJoinerJoinRate, on.summary.observerJoinerJoinRate),
      observerJoinerLeaveRate: metricDelta(off.summary.observerJoinerLeaveRate, on.summary.observerJoinerLeaveRate),
      groupFailureRate: metricDelta(off.summary.groupFailureRate, on.summary.groupFailureRate),
      averageFirstGroupConfirmedTick: optionalMetricDelta(
        off.summary.averageFirstGroupConfirmedTick,
        on.summary.averageFirstGroupConfirmedTick,
      ),
      lateJoinSuccessRate: metricDelta(off.summary.lateJoinSuccessRate, on.summary.lateJoinSuccessRate),
      averageJoinedCount: metricDelta(off.summary.averageJoinedCount, on.summary.averageJoinedCount),
      averageLeftCount: metricDelta(off.summary.averageLeftCount, on.summary.averageLeftCount),
    },
    phase4Metrics: {
      divergenceCount: metricDelta(
        off.phase4Summary.averageDivergenceCount,
        on.phase4Summary.averageDivergenceCount,
      ),
      expressedSpeechCount: metricDelta(
        off.phase4Summary.averageExpressedSpeechCount,
        on.phase4Summary.averageExpressedSpeechCount,
      ),
      trustChangeAmount: metricDelta(
        off.phase4Summary.averageTrustChangeAmount,
        on.phase4Summary.averageTrustChangeAmount,
      ),
      tieChangeAmount: metricDelta(
        off.phase4Summary.averageTieChangeAmount,
        on.phase4Summary.averageTieChangeAmount,
      ),
    },
  };
}
