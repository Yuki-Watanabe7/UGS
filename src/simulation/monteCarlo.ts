import type {
  MonteCarloComparisonResult,
  MonteCarloConfig,
  MonteCarloMetricDelta,
  MonteCarloResult,
  MonteCarloRunOptions,
  MonteCarloRunResult,
  MonteCarloSummary,
  PairFormationMonteCarloResult,
  PairFormationRunSummary,
  SimParams,
  SimulationSummary,
} from "./types";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { buildSimulationSummary } from "./summary";
import { buildPairFormationRunSummary, summarizePairFormationRuns } from "./pairFormation";

/**
 * Monte Carlo層としての安全上限tick数。engine.ts内部の`tick >= 400`終了とは独立に持たせ、
 * 将来engine側の上限が変わっても`runSimulationToEnd`が無限ループしないようにするための保険。
 * `speechEffectsMonteCarlo.ts`のpaired比較も同じ上限を使う(受入条件: 既存Monte Carlo運用に合わせる)。
 */
export const DEFAULT_MAX_TICKS = 1000;

/**
 * 単一seedのシミュレーションを、終了(`state.finished`)または安全上限tickに達するまで実行する。
 * `createInitialState`/`stepSimulation`/`SeededRandom`/`buildSimulationSummary`を組み合わせるだけで、
 * `params`はmutationしない(いずれの関数も内部で読み取るのみで、コピーを返す)。
 */
export function runSimulationToEnd(
  seed: number,
  params: SimParams,
  options?: MonteCarloRunOptions,
): { summary: SimulationSummary; finishedTick: number; pairFormation: PairFormationRunSummary } {
  const maxTicks = options?.maxTicks ?? DEFAULT_MAX_TICKS;
  const intervention = options?.intervention;
  const speechEffects = options?.speechEffects;
  // Issue #136: classroomPair(学校シナリオ)等のMonte Carlo集計を行うには、単発実行と同様に
  // 形成ポリシーもrunごとに渡せる必要がある。省略時は`resolveFormationPolicy`の既定値("afterParty")
  const formation = options?.formation;
  const rng = new SeededRandom(seed);

  let state = createInitialState(seed, params, intervention, speechEffects, undefined, undefined, undefined, formation);
  while (!state.finished && state.tick < maxTicks) {
    state = stepSimulation(state, params, rng, intervention, speechEffects, undefined, undefined, undefined, formation);
  }

  const summary = buildSimulationSummary(state);
  const finishedTick = summary.finishedTick ?? state.tick;
  // Issue #136: ペア/グループ形成過程の集計(未割当・参加失敗・再探索等)も、既存の`summary`と
  // 同じ最終stateから同時に導出する(state自体はこの呼び出しの外に持ち出さない)
  const pairFormation = buildPairFormationRunSummary(state, params);

  return { summary, finishedTick, pairFormation };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function rateOf(runs: MonteCarloRunResult[], predicate: (run: MonteCarloRunResult) => boolean): number {
  if (runs.length === 0) return 0;
  return runs.filter(predicate).length / runs.length;
}

/**
 * `runs`から既存の主要指標を集計する。`speechEffectsMonteCarlo.ts`のpaired比較も、既存指標については
 * この関数をそのまま再利用する(既存介入比較と同じ集計ロジックを使うことを型・値の両面で保証するため)。
 */
export function summarizeRuns(runs: MonteCarloRunResult[]): MonteCarloSummary {
  const observerJoinerJoinRate = rateOf(runs, (run) =>
    run.summary.observerJoiners.some((o) => o.finalState === "joined"),
  );
  const observerJoinerLeaveRate = rateOf(runs, (run) =>
    run.summary.observerJoiners.some((o) => o.leaveStartedTick !== undefined || o.leftTick !== undefined),
  );
  const groupFailureRate = rateOf(runs, (run) => run.summary.groupFailure);
  const lateJoinSuccessRate = rateOf(runs, (run) =>
    run.summary.observerJoiners.some((o) => o.lateJoinSucceeded),
  );

  const confirmedTicks = runs
    .map((run) => run.summary.firstGroupConfirmedTick)
    .filter((tick): tick is number => tick !== undefined);
  const averageFirstGroupConfirmedTick = confirmedTicks.length === 0 ? undefined : average(confirmedTicks);

  return {
    runs: runs.length,
    observerJoinerJoinRate,
    observerJoinerLeaveRate,
    groupFailureRate,
    averageFirstGroupConfirmedTick,
    lateJoinSuccessRate,
    averageJoinedCount: average(runs.map((run) => run.summary.joinedCount)),
    averageLeftCount: average(runs.map((run) => run.summary.leftCount)),
  };
}

/**
 * 同一プリセット・同一paramsで、`config.runs`回分のseed(`baseSeed + index`)を一括実行し、
 * 個別run結果と集計値の両方を返す。`config.params`はmutationしない。
 */
export function runMonteCarlo(config: MonteCarloConfig): MonteCarloResult {
  const { baseSeed, runs: runCount, params, maxTicks, intervention, speechEffects, formation } = config;

  const runs: MonteCarloRunResult[] = [];
  for (let index = 0; index < runCount; index++) {
    const seed = baseSeed + index;
    const { summary, finishedTick } = runSimulationToEnd(seed, params, {
      maxTicks,
      intervention,
      speechEffects,
      formation,
    });
    runs.push({ seed, summary, finishedTick });
  }

  return {
    config,
    runs,
    summary: summarizeRuns(runs),
  };
}

/**
 * Issue #136: `runMonteCarlo`と同じ実行(同一seed列)を行い、既存の主要指標に加えて
 * ペア/グループ形成過程の集計(未割当・参加失敗・再探索・完了tick分布等)も返す。
 * `speechEffectsMonteCarlo.ts`/`phase4MonteCarlo.ts`のoff/on paired比較とは異なり、
 * こちらはON/OFFの切り替えを持たない単一条件の集計拡張(既存Monte Carlo運用への追加軸)。
 */
export function runPairFormationMonteCarlo(config: MonteCarloConfig): PairFormationMonteCarloResult {
  const { baseSeed, runs: runCount, params, maxTicks, intervention, speechEffects, formation } = config;

  const runs: MonteCarloRunResult[] = [];
  const pairFormationRuns: PairFormationRunSummary[] = [];
  for (let index = 0; index < runCount; index++) {
    const seed = baseSeed + index;
    const { summary, finishedTick, pairFormation } = runSimulationToEnd(seed, params, {
      maxTicks,
      intervention,
      speechEffects,
      formation,
    });
    runs.push({ seed, summary, finishedTick });
    pairFormationRuns.push(pairFormation);
  }

  return {
    config,
    runs,
    summary: summarizeRuns(runs),
    pairFormationRuns,
    pairFormationSummary: summarizePairFormationRuns(runs, pairFormationRuns),
  };
}

/** `speechEffectsMonteCarlo.ts`のpaired比較も、既存の主要指標についてはこの関数をそのまま再利用する */
export function metricDelta(baseline: number, intervention: number): MonteCarloMetricDelta {
  return { baseline, intervention, delta: intervention - baseline };
}

export function optionalMetricDelta(
  baseline: number | undefined,
  intervention: number | undefined,
): MonteCarloMetricDelta<number | undefined> {
  const delta = baseline !== undefined && intervention !== undefined ? intervention - baseline : undefined;
  return { baseline, intervention, delta };
}

/**
 * 選択中の介入(`config.intervention`)と、介入なし(baseline)を、同一の`presetId`由来`params`・
 * `baseSeed`・`runs`・`maxTicks`で比較実行する。`config.params`はmutationしない。
 * baseline側は`config.intervention`を無視し、常に`interventionId: "none"`で実行する。
 */
export function compareMonteCarloIntervention(config: MonteCarloConfig): MonteCarloComparisonResult {
  const baseline = runMonteCarlo({ ...config, intervention: { interventionId: "none" } });
  const intervention = runMonteCarlo(config);

  return {
    baseline,
    intervention,
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
  };
}
