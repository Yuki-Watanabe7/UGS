import type {
  MonteCarloRunResult,
  SimParams,
  SpeechEffectsComparisonResult,
  SpeechEffectsMonteCarloConfig,
  SpeechEffectsMonteCarloResult,
  SpeechEffectsMonteCarloSummary,
  SpeechEffectsRunSummary,
} from "./types";
import type { InterventionRuntimeOptions } from "./interventions";
import type { SpeechEffectDimension } from "./speechEffects";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { buildSimulationSummary, buildSpeechEffectsRunSummary } from "./summary";
import { DEFAULT_MAX_TICKS, metricDelta, optionalMetricDelta, summarizeRuns } from "./monteCarlo";

/**
 * Issue #99: 発言効果ON/OFF paired比較。同一preset由来`params`・`intervention`・`baseSeed`・`runs`で、
 * `speechEffects.enabled`だけをfalse/trueに切り替えたペアを実行し、既存の主要指標とPhase 3固有指標の
 * 両方について差分を返す。
 *
 * paired性の根拠: `speechEffects.ts`の各`derive*`関数はいずれも`rng`を読み取らない(発言の認知/解釈/
 * 効果はすべて距離・性格パラメータ・現在stateからの決定的な計算のみで、確率的な要素を持たない)ため、
 * `speechEffectsConfig.enabled`の値はSeededRandomの消費順序に一切影響しない。よってoff/on同じseedの
 * runは、Phase 3効果が実際にengine.tsの計算式へ加算される分だけが異なり、それ以外の乱数選択は
 * 完全に同じ列をたどる(詳細は`docs/speech-effects-paired-monte-carlo.md`参照)。
 */
function runSingleCondition(
  seed: number,
  params: SimParams,
  enabled: boolean,
  maxTicks: number,
  intervention: InterventionRuntimeOptions | undefined,
): { runResult: MonteCarloRunResult; speechEffectsRunSummary: SpeechEffectsRunSummary } {
  const rng = new SeededRandom(seed);
  let state = createInitialState(seed, params, intervention, { enabled });
  while (!state.finished && state.tick < maxTicks) {
    state = stepSimulation(state, params, rng, intervention, { enabled });
  }

  const summary = buildSimulationSummary(state);
  const finishedTick = summary.finishedTick ?? state.tick;
  const speechEffectsRunSummary = buildSpeechEffectsRunSummary(state);

  return { runResult: { seed, summary, finishedTick }, speechEffectsRunSummary };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function rateOf(runs: SpeechEffectsRunSummary[], predicate: (run: SpeechEffectsRunSummary) => boolean): number {
  if (runs.length === 0) return 0;
  return runs.filter(predicate).length / runs.length;
}

const DIMENSIONS: SpeechEffectDimension[] = ["stress", "attractiveness", "approachProbability", "leaveThreshold"];

/** `runs`からPhase 3固有指標を集計する。既存指標(`summarizeRuns`)とは完全に独立した集計軸 */
export function summarizeSpeechEffectsRuns(runs: SpeechEffectsRunSummary[]): SpeechEffectsMonteCarloSummary {
  const averageDimensionTotals = DIMENSIONS.reduce(
    (acc, dimension) => {
      acc[dimension] = average(runs.map((run) => run.dimensionTotals[dimension]));
      return acc;
    },
    {} as Record<SpeechEffectDimension, number>,
  );

  return {
    runs: runs.length,
    observerJoinerHeardSpeechRate: rateOf(runs, (run) => run.observerJoinerHeardSpeech),
    interpretationOrEffectRate: rateOf(runs, (run) => run.hadInterpretationOrEffect),
    averageDimensionTotals,
    transitionInfluencedRate: rateOf(runs, (run) => run.transitionInfluenced),
  };
}

/**
 * 単一条件(発言効果off/onのいずれか)で`config.runs`回分のseedを実行する。既存指標は`summarizeRuns`
 * (`monteCarlo.ts`)をそのまま再利用し、Phase 3固有指標は`summarizeSpeechEffectsRuns`で別途集計する。
 */
export function runSpeechEffectsMonteCarlo(
  config: SpeechEffectsMonteCarloConfig,
  enabled: boolean,
): SpeechEffectsMonteCarloResult {
  const { baseSeed, runs: runCount, params, maxTicks, intervention } = config;
  const resolvedMaxTicks = maxTicks ?? DEFAULT_MAX_TICKS;

  const runs: MonteCarloRunResult[] = [];
  const speechEffectsRuns: SpeechEffectsRunSummary[] = [];
  for (let index = 0; index < runCount; index++) {
    const seed = baseSeed + index;
    const { runResult, speechEffectsRunSummary } = runSingleCondition(
      seed,
      params,
      enabled,
      resolvedMaxTicks,
      intervention,
    );
    runs.push(runResult);
    speechEffectsRuns.push(speechEffectsRunSummary);
  }

  return {
    config,
    runs,
    summary: summarizeRuns(runs),
    speechEffectsRuns,
    speechEffectsSummary: summarizeSpeechEffectsRuns(speechEffectsRuns),
  };
}

/**
 * 同一`presetId`由来`params`・`intervention`・`baseSeed`・`runs`・`maxTicks`で、発言効果off(`enabled:
 * false`)とon(`enabled: true`)を実行し、既存の主要指標とPhase 3固有指標の両方について差分を返す。
 * `off`はこのtickまでの発言生成(Phase 2)は行うが認知・解釈・効果(Phase 3)を一切生成しない条件、
 * `on`は同じ発言をPhase 3まで通した条件で、run i同士は`baseSeed + i`で1:1に対応する(paired比較)。
 */
export function compareSpeechEffects(config: SpeechEffectsMonteCarloConfig): SpeechEffectsComparisonResult {
  const off = runSpeechEffectsMonteCarlo(config, false);
  const on = runSpeechEffectsMonteCarlo(config, true);

  const pairedSeeds = off.runs.map((run) => run.seed);

  const dimensionTotals = DIMENSIONS.reduce(
    (acc, dimension) => {
      acc[dimension] = metricDelta(
        off.speechEffectsSummary.averageDimensionTotals[dimension],
        on.speechEffectsSummary.averageDimensionTotals[dimension],
      );
      return acc;
    },
    {} as Record<SpeechEffectDimension, ReturnType<typeof metricDelta>>,
  );

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
    phase3Metrics: {
      observerJoinerHeardSpeechRate: metricDelta(
        off.speechEffectsSummary.observerJoinerHeardSpeechRate,
        on.speechEffectsSummary.observerJoinerHeardSpeechRate,
      ),
      interpretationOrEffectRate: metricDelta(
        off.speechEffectsSummary.interpretationOrEffectRate,
        on.speechEffectsSummary.interpretationOrEffectRate,
      ),
      transitionInfluencedRate: metricDelta(
        off.speechEffectsSummary.transitionInfluencedRate,
        on.speechEffectsSummary.transitionInfluencedRate,
      ),
      dimensionTotals,
    },
  };
}
