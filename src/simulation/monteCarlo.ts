import type {
  MonteCarloConfig,
  MonteCarloResult,
  MonteCarloRunOptions,
  MonteCarloRunResult,
  MonteCarloSummary,
  SimParams,
  SimulationSummary,
} from "./types";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { buildSimulationSummary } from "./summary";

/**
 * Monte Carlo層としての安全上限tick数。engine.ts内部の`tick >= 400`終了とは独立に持たせ、
 * 将来engine側の上限が変わっても`runSimulationToEnd`が無限ループしないようにするための保険。
 */
const DEFAULT_MAX_TICKS = 1000;

/**
 * 単一seedのシミュレーションを、終了(`state.finished`)または安全上限tickに達するまで実行する。
 * `createInitialState`/`stepSimulation`/`SeededRandom`/`buildSimulationSummary`を組み合わせるだけで、
 * `params`はmutationしない(いずれの関数も内部で読み取るのみで、コピーを返す)。
 */
export function runSimulationToEnd(
  seed: number,
  params: SimParams,
  options?: MonteCarloRunOptions,
): { summary: SimulationSummary; finishedTick: number } {
  const maxTicks = options?.maxTicks ?? DEFAULT_MAX_TICKS;
  const rng = new SeededRandom(seed);

  let state = createInitialState(seed, params);
  while (!state.finished && state.tick < maxTicks) {
    state = stepSimulation(state, params, rng);
  }

  const summary = buildSimulationSummary(state);
  const finishedTick = summary.finishedTick ?? state.tick;

  return { summary, finishedTick };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function rateOf(runs: MonteCarloRunResult[], predicate: (run: MonteCarloRunResult) => boolean): number {
  if (runs.length === 0) return 0;
  return runs.filter(predicate).length / runs.length;
}

function summarizeRuns(runs: MonteCarloRunResult[]): MonteCarloSummary {
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
  const { baseSeed, runs: runCount, params, maxTicks } = config;

  const runs: MonteCarloRunResult[] = [];
  for (let index = 0; index < runCount; index++) {
    const seed = baseSeed + index;
    const { summary, finishedTick } = runSimulationToEnd(seed, params, { maxTicks });
    runs.push({ seed, summary, finishedTick });
  }

  return {
    config,
    runs,
    summary: summarizeRuns(runs),
  };
}
