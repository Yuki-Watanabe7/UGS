import { describe, expect, it } from "vitest";
import { comparePhase4Model, runPhase4MonteCarlo, summarizePhase4Runs } from "./phase4MonteCarlo";
import { DEFAULT_PARAMS, getPresetById } from "./presets";
import type { Phase4MonteCarloConfig, SimParams } from "./types";

const SMALL_RUNS = 4;

describe("runPhase4MonteCarlo", () => {
  const config: Phase4MonteCarloConfig = {
    baseSeed: 1000,
    runs: SMALL_RUNS,
    params: DEFAULT_PARAMS,
  };

  it("runs `runs` seeds and returns one Phase 4 run summary per seed", () => {
    const off = runPhase4MonteCarlo(config, false);

    expect(off.runs).toHaveLength(SMALL_RUNS);
    expect(off.runs.map((r) => r.seed)).toEqual([1000, 1001, 1002, 1003]);
    expect(off.phase4Runs).toHaveLength(SMALL_RUNS);
  });

  it("is deterministic for the same config and enabled flag", () => {
    const a = runPhase4MonteCarlo(config, true);
    const b = runPhase4MonteCarlo(config, true);

    expect(a).toEqual(b);
  });

  it("does not mutate config.params", () => {
    const params: SimParams = { ...DEFAULT_PARAMS };
    const snapshot = { ...params };

    runPhase4MonteCarlo({ baseSeed: 5, runs: SMALL_RUNS, params }, true);

    expect(params).toEqual(snapshot);
  });

  it("never records divergence/trust/tie changes when enabled: false, regardless of how much speech occurs", () => {
    const preset = getPresetById("natural");
    const { phase4Runs } = runPhase4MonteCarlo({ baseSeed: 42, runs: 10, params: preset.params }, false);

    for (const run of phase4Runs) {
      expect(run.divergenceCount).toBe(0);
      expect(run.expressedSpeechCount).toBe(0);
      expect(run.trustChangeAmount).toBe(0);
      expect(run.tieChangeAmount).toBe(0);
    }
  });

  it("shows non-zero divergence/expressed-speech counts on a preset that reliably produces speech when enabled: true", () => {
    const preset = getPresetById("natural");
    const { phase4Summary } = runPhase4MonteCarlo({ baseSeed: 9000, runs: 20, params: preset.params }, true);

    expect(phase4Summary.averageExpressedSpeechCount).toBeGreaterThan(0);
  });
});

describe("summarizePhase4Runs", () => {
  it("averages each Phase 4 metric independently and returns 0 for an empty run list", () => {
    const summary = summarizePhase4Runs([]);

    expect(summary).toEqual({
      runs: 0,
      averageDivergenceCount: 0,
      averageExpressedSpeechCount: 0,
      averageTrustChangeAmount: 0,
      averageTieChangeAmount: 0,
    });
  });

  it("computes a plain arithmetic mean across runs", () => {
    const summary = summarizePhase4Runs([
      { divergenceCount: 2, expressedSpeechCount: 4, trustChangeAmount: 0.1, tieChangeAmount: 0.02 },
      { divergenceCount: 4, expressedSpeechCount: 8, trustChangeAmount: 0.3, tieChangeAmount: 0.06 },
    ]);

    expect(summary.runs).toBe(2);
    expect(summary.averageDivergenceCount).toBeCloseTo(3);
    expect(summary.averageExpressedSpeechCount).toBeCloseTo(6);
    expect(summary.averageTrustChangeAmount).toBeCloseTo(0.2);
    expect(summary.averageTieChangeAmount).toBeCloseTo(0.04);
  });
});

describe("comparePhase4Model", () => {
  const config: Phase4MonteCarloConfig = {
    baseSeed: 3000,
    runs: SMALL_RUNS,
    params: DEFAULT_PARAMS,
    intervention: { interventionId: "late-join-ok" },
  };

  it("runs off and on with the same baseSeed/runs/params/intervention, paired by seed", () => {
    const comparison = comparePhase4Model(config);

    expect(comparison.off.config.baseSeed).toBe(config.baseSeed);
    expect(comparison.on.config.baseSeed).toBe(config.baseSeed);
    expect(comparison.off.runs.map((r) => r.seed)).toEqual(comparison.on.runs.map((r) => r.seed));
    expect(comparison.pairedSeeds).toEqual(comparison.off.runs.map((r) => r.seed));
  });

  it("is reproducible for the same input (same aggregate result and run order)", () => {
    const a = comparePhase4Model(config);
    const b = comparePhase4Model(config);

    expect(a).toEqual(b);
  });

  it("does not mutate config.params", () => {
    const params: SimParams = { ...DEFAULT_PARAMS };
    const snapshot = { ...params };

    comparePhase4Model({ baseSeed: 5, runs: SMALL_RUNS, params, intervention: { interventionId: "late-join-ok" } });

    expect(params).toEqual(snapshot);
  });

  it("computes delta as on - off for both existing and Phase 4 metrics", () => {
    const comparison = comparePhase4Model(config);

    expect(comparison.metrics.observerJoinerJoinRate.delta).toBeCloseTo(
      comparison.on.summary.observerJoinerJoinRate - comparison.off.summary.observerJoinerJoinRate,
    );
    expect(comparison.phase4Metrics.divergenceCount.delta).toBeCloseTo(
      comparison.on.phase4Summary.averageDivergenceCount - comparison.off.phase4Summary.averageDivergenceCount,
    );
    expect(comparison.phase4Metrics.trustChangeAmount.delta).toBeCloseTo(
      comparison.on.phase4Summary.averageTrustChangeAmount - comparison.off.phase4Summary.averageTrustChangeAmount,
    );
  });

  it("keeps every Phase 4 off-side metric at zero (nothing to turn on) since Phase 4 never fires when disabled", () => {
    const comparison = comparePhase4Model(config);

    expect(comparison.phase4Metrics.divergenceCount.baseline).toBe(0);
    expect(comparison.phase4Metrics.expressedSpeechCount.baseline).toBe(0);
    expect(comparison.phase4Metrics.trustChangeAmount.baseline).toBe(0);
    expect(comparison.phase4Metrics.tieChangeAmount.baseline).toBe(0);
  });

  it("produces an all-zero diff for both existing and Phase 4 metrics when no speech can ever occur (maxTicks: 0)", () => {
    const comparison = comparePhase4Model({ ...config, maxTicks: 0 });

    expect(comparison.metrics.observerJoinerJoinRate.delta).toBe(0);
    expect(comparison.metrics.observerJoinerLeaveRate.delta).toBe(0);
    expect(comparison.metrics.groupFailureRate.delta).toBe(0);
    expect(comparison.metrics.lateJoinSuccessRate.delta).toBe(0);
    expect(comparison.metrics.averageJoinedCount.delta).toBe(0);
    expect(comparison.metrics.averageLeftCount.delta).toBe(0);

    expect(comparison.phase4Metrics.divergenceCount.delta).toBe(0);
    expect(comparison.phase4Metrics.expressedSpeechCount.delta).toBe(0);
    expect(comparison.phase4Metrics.trustChangeAmount.delta).toBe(0);
    expect(comparison.phase4Metrics.tieChangeAmount.delta).toBe(0);
  });

  it("shows a non-zero divergence count on the 'on' side for a preset that reliably produces speech", () => {
    const preset = getPresetById("natural");

    const comparison = comparePhase4Model({ baseSeed: 9000, runs: 20, params: preset.params });

    expect(comparison.on.phase4Summary.averageExpressedSpeechCount).toBeGreaterThan(0);
  });
});
