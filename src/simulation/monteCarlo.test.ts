import { describe, expect, it } from "vitest";
import { compareMonteCarloIntervention, runMonteCarlo, runSimulationToEnd } from "./monteCarlo";
import { DEFAULT_PARAMS, getPresetById } from "./presets";
import type { MonteCarloConfig, SimParams } from "./types";

const SMALL_RUNS = 4;

describe("runSimulationToEnd", () => {
  it("runs a single seed to completion and returns a summary consistent with buildSimulationSummary's shape", () => {
    const { summary, finishedTick } = runSimulationToEnd(1, DEFAULT_PARAMS);

    expect(summary.finished).toBe(true);
    expect(finishedTick).toBe(summary.finishedTick);
    expect(summary.joinedCount + summary.leftCount).toBeLessThanOrEqual(DEFAULT_PARAMS.populationSize);
    expect(summary.observerJoiners.length).toBeGreaterThan(0);
  });

  it("does not mutate params", () => {
    const params: SimParams = { ...DEFAULT_PARAMS };
    const snapshot = { ...params };

    runSimulationToEnd(42, params);

    expect(params).toEqual(snapshot);
  });

  it("is deterministic for the same seed and params", () => {
    const a = runSimulationToEnd(7, DEFAULT_PARAMS);
    const b = runSimulationToEnd(7, DEFAULT_PARAMS);

    expect(a).toEqual(b);
  });
});

describe("runMonteCarlo", () => {
  const config: MonteCarloConfig = {
    baseSeed: 1000,
    runs: SMALL_RUNS,
    params: DEFAULT_PARAMS,
  };

  it("runs `runs` seeds and returns one result per run with non-overlapping seeds", () => {
    const result = runMonteCarlo(config);

    expect(result.runs).toHaveLength(SMALL_RUNS);
    const seeds = result.runs.map((r) => r.seed);
    expect(seeds).toEqual([1000, 1001, 1002, 1003]);
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  it("works correctly with runs: 1", () => {
    const result = runMonteCarlo({ ...config, runs: 1 });

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.seed).toBe(config.baseSeed);
    expect(result.summary.runs).toBe(1);
  });

  it("returns the same aggregate summary for the same baseSeed/runs/params", () => {
    const a = runMonteCarlo(config);
    const b = runMonteCarlo(config);

    expect(a).toEqual(b);
  });

  it("does not mutate config.params", () => {
    const params: SimParams = { ...DEFAULT_PARAMS };
    const snapshot = { ...params };

    runMonteCarlo({ baseSeed: 5, runs: SMALL_RUNS, params });

    expect(params).toEqual(snapshot);
  });

  it("keeps rate metrics within [0, 1]", () => {
    const { summary } = runMonteCarlo({ baseSeed: 2024, runs: 8, params: DEFAULT_PARAMS });

    for (const rate of [
      summary.observerJoinerJoinRate,
      summary.observerJoinerLeaveRate,
      summary.groupFailureRate,
      summary.lateJoinSuccessRate,
    ]) {
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(1);
    }
  });

  it("reports averageFirstGroupConfirmedTick as undefined when no run ever confirms a group", () => {
    const impossibleParams: SimParams = {
      ...DEFAULT_PARAMS,
      populationSize: 5,
      groupConfirmSize: 99,
      numLeaders: 0,
      existingTieStrength: 0,
    };

    const { summary } = runMonteCarlo({ baseSeed: 1, runs: SMALL_RUNS, params: impossibleParams });

    expect(summary.groupFailureRate).toBe(1);
    expect(summary.averageFirstGroupConfirmedTick).toBeUndefined();
  });

  it("produces individual run summaries structurally consistent with SimulationSummary", () => {
    const { runs } = runMonteCarlo(config);

    for (const run of runs) {
      expect(run.summary.finished).toBe(true);
      expect(run.finishedTick).toBe(run.summary.finishedTick);
      expect(run.summary.stateCounts.joined).toBe(run.summary.joinedCount);
      expect(run.summary.stateCounts.left).toBe(run.summary.leftCount);
    }
  });

  it("passes the same intervention to every run, same as a single runSimulationToEnd call would use", () => {
    const intervention = { interventionId: "late-join-ok" as const };

    const { runs } = runMonteCarlo({ ...config, intervention });
    const single = runSimulationToEnd(config.baseSeed, config.params, { intervention });

    expect(runs[0]?.summary).toEqual(single.summary);
  });

  it("does not change results relative to omitting intervention when interventionId is 'none'", () => {
    const withNone = runMonteCarlo({ ...config, intervention: { interventionId: "none" } });
    const withoutField = runMonteCarlo(config);

    expect(withNone.runs).toEqual(withoutField.runs);
    expect(withNone.summary).toEqual(withoutField.summary);
  });
});

describe("Phase C: public-coordination interventions show up in Monte Carlo aggregates", () => {
  const RUNS = 30;

  it("explicit-meeting-point turns near-total group failure into near-total success in a leaderless, ambiguous scenario", () => {
    // ambiguous-dissolveはnumLeaders:0かつ既存関係性も弱いため、通常は誰も核を作らずグループが不成立になりやすい。
    // 集合場所という「founderを必要としない」候補が1つあるだけで、この前提が覆ることを確認する。
    const preset = getPresetById("ambiguous-dissolve");

    const withIntervention = runMonteCarlo({
      baseSeed: 3000,
      runs: RUNS,
      params: preset.params,
      intervention: { interventionId: "explicit-meeting-point" },
    });
    const withoutIntervention = runMonteCarlo({ baseSeed: 3000, runs: RUNS, params: preset.params });

    expect(withoutIntervention.summary.groupFailureRate).toBe(1);
    expect(withIntervention.summary.groupFailureRate).toBe(0);
    expect(withIntervention.summary.observerJoinerJoinRate).toBeGreaterThan(
      withoutIntervention.summary.observerJoinerJoinRate,
    );
  });

  it("predecided-venue raises the observerJoiner join rate in a clique-isolated scenario", () => {
    const preset = getPresetById("leftover-free-grouping");

    const withIntervention = runMonteCarlo({
      baseSeed: 4000,
      runs: RUNS,
      params: preset.params,
      intervention: { interventionId: "predecided-venue" },
    });
    const withoutIntervention = runMonteCarlo({ baseSeed: 4000, runs: RUNS, params: preset.params });

    expect(withIntervention.summary.observerJoinerJoinRate).toBeGreaterThan(
      withoutIntervention.summary.observerJoinerJoinRate,
    );
    expect(withIntervention.summary.observerJoinerLeaveRate).toBeLessThan(
      withoutIntervention.summary.observerJoinerLeaveRate,
    );
  });

  it("short-ambiguity-window raises the observerJoiner join rate rather than simply raising the leave rate, in a clique-isolated scenario", () => {
    const preset = getPresetById("leftover-free-grouping");

    const withIntervention = runMonteCarlo({
      baseSeed: 5000,
      runs: RUNS,
      params: preset.params,
      intervention: { interventionId: "short-ambiguity-window" },
    });
    const withoutIntervention = runMonteCarlo({ baseSeed: 5000, runs: RUNS, params: preset.params });

    expect(withIntervention.summary.observerJoinerJoinRate).toBeGreaterThan(
      withoutIntervention.summary.observerJoinerJoinRate,
    );
    expect(withIntervention.summary.observerJoinerLeaveRate).toBeLessThan(
      withoutIntervention.summary.observerJoinerLeaveRate,
    );
  });
});

describe("compareMonteCarloIntervention", () => {
  const config: MonteCarloConfig = {
    baseSeed: 3000,
    runs: SMALL_RUNS,
    params: DEFAULT_PARAMS,
    intervention: { interventionId: "late-join-ok" },
  };

  it("runs baseline and intervention with the same baseSeed/runs/params", () => {
    const comparison = compareMonteCarloIntervention(config);

    expect(comparison.baseline.config.baseSeed).toBe(config.baseSeed);
    expect(comparison.baseline.config.runs).toBe(config.runs);
    expect(comparison.baseline.config.params).toEqual(config.params);
    expect(comparison.baseline.runs.map((r) => r.seed)).toEqual(comparison.intervention.runs.map((r) => r.seed));
  });

  it("always runs baseline with interventionId 'none', regardless of config.intervention", () => {
    const comparison = compareMonteCarloIntervention(config);
    const expectedBaseline = runMonteCarlo({ ...config, intervention: { interventionId: "none" } });

    expect(comparison.baseline).toEqual(expectedBaseline);
  });

  it("computes delta as intervention - baseline for rate and count metrics", () => {
    const comparison = compareMonteCarloIntervention(config);

    expect(comparison.metrics.observerJoinerJoinRate.delta).toBeCloseTo(
      comparison.intervention.summary.observerJoinerJoinRate - comparison.baseline.summary.observerJoinerJoinRate,
    );
    expect(comparison.metrics.groupFailureRate.delta).toBeCloseTo(
      comparison.intervention.summary.groupFailureRate - comparison.baseline.summary.groupFailureRate,
    );
    expect(comparison.metrics.averageJoinedCount.delta).toBeCloseTo(
      comparison.intervention.summary.averageJoinedCount - comparison.baseline.summary.averageJoinedCount,
    );
    expect(comparison.metrics.averageLeftCount.delta).toBeCloseTo(
      comparison.intervention.summary.averageLeftCount - comparison.baseline.summary.averageLeftCount,
    );
  });

  it("keeps averageFirstGroupConfirmedTick's delta undefined when either side never confirms a group", () => {
    const impossibleParams: SimParams = {
      ...DEFAULT_PARAMS,
      populationSize: 5,
      groupConfirmSize: 99,
      numLeaders: 0,
      existingTieStrength: 0,
    };

    const comparison = compareMonteCarloIntervention({
      baseSeed: 1,
      runs: SMALL_RUNS,
      params: impossibleParams,
      intervention: { interventionId: "late-join-ok" },
    });

    expect(comparison.baseline.summary.averageFirstGroupConfirmedTick).toBeUndefined();
    expect(comparison.metrics.averageFirstGroupConfirmedTick.baseline).toBeUndefined();
    expect(comparison.metrics.averageFirstGroupConfirmedTick.delta).toBeUndefined();
  });

  it("does not mutate config.params", () => {
    const params: SimParams = { ...DEFAULT_PARAMS };
    const snapshot = { ...params };

    compareMonteCarloIntervention({
      baseSeed: 5,
      runs: SMALL_RUNS,
      params,
      intervention: { interventionId: "late-join-ok" },
    });

    expect(params).toEqual(snapshot);
  });

  it("shows an improved observerJoiner join/leave delta for predecided-venue in a clique-isolated scenario", () => {
    const preset = getPresetById("leftover-free-grouping");

    const comparison = compareMonteCarloIntervention({
      baseSeed: 4000,
      runs: 30,
      params: preset.params,
      intervention: { interventionId: "predecided-venue" },
    });

    expect(comparison.metrics.observerJoinerJoinRate.delta).toBeGreaterThan(0);
    expect(comparison.metrics.observerJoinerLeaveRate.delta).toBeLessThan(0);
  });
});
