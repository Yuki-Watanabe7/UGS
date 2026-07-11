import { describe, expect, it } from "vitest";
import { compareSpeechEffects, runSpeechEffectsMonteCarlo } from "./speechEffectsMonteCarlo";
import { runMonteCarlo } from "./monteCarlo";
import { DEFAULT_PARAMS, getPresetById } from "./presets";
import type { SimParams, SpeechEffectsMonteCarloConfig } from "./types";

const SMALL_RUNS = 4;

describe("runSpeechEffectsMonteCarlo", () => {
  const config: SpeechEffectsMonteCarloConfig = {
    baseSeed: 1000,
    runs: SMALL_RUNS,
    params: DEFAULT_PARAMS,
  };

  it("runs `runs` seeds and returns one run per seed, matching runMonteCarlo's own seed sequence", () => {
    const off = runSpeechEffectsMonteCarlo(config, false);

    expect(off.runs).toHaveLength(SMALL_RUNS);
    expect(off.runs.map((r) => r.seed)).toEqual([1000, 1001, 1002, 1003]);
    expect(off.speechEffectsRuns).toHaveLength(SMALL_RUNS);
  });

  it("is deterministic for the same config and enabled flag", () => {
    const a = runSpeechEffectsMonteCarlo(config, true);
    const b = runSpeechEffectsMonteCarlo(config, true);

    expect(a).toEqual(b);
  });

  it("does not mutate config.params", () => {
    const params: SimParams = { ...DEFAULT_PARAMS };
    const snapshot = { ...params };

    runSpeechEffectsMonteCarlo({ baseSeed: 5, runs: SMALL_RUNS, params }, true);

    expect(params).toEqual(snapshot);
  });

  it("keeps Phase 3 rate metrics within [0, 1]", () => {
    const { speechEffectsSummary } = runSpeechEffectsMonteCarlo(
      { baseSeed: 2024, runs: 8, params: DEFAULT_PARAMS },
      true,
    );

    for (const rate of [
      speechEffectsSummary.observerJoinerHeardSpeechRate,
      speechEffectsSummary.interpretationOrEffectRate,
      speechEffectsSummary.transitionInfluencedRate,
    ]) {
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(1);
    }
  });

  it("reuses runMonteCarlo's existing-metric aggregation exactly when enabled: false matches the default (disabled) behavior", () => {
    const withSpeechEffectsOff = runSpeechEffectsMonteCarlo(config, false);
    const plainMonteCarlo = runMonteCarlo(config);

    expect(withSpeechEffectsOff.summary).toEqual(plainMonteCarlo.summary);
    expect(withSpeechEffectsOff.runs).toEqual(plainMonteCarlo.runs);
  });

  it("never generates Phase 3 effects when enabled: false, regardless of how much speech occurs", () => {
    const preset = getPresetById("natural");
    const { speechEffectsRuns } = runSpeechEffectsMonteCarlo(
      { baseSeed: 42, runs: 10, params: preset.params },
      false,
    );

    for (const run of speechEffectsRuns) {
      expect(run.observerJoinerHeardSpeech).toBe(false);
      expect(run.hadInterpretationOrEffect).toBe(false);
      expect(run.transitionInfluenced).toBe(false);
      expect(Object.values(run.dimensionTotals).every((v) => v === 0)).toBe(true);
    }
  });
});

describe("compareSpeechEffects", () => {
  const config: SpeechEffectsMonteCarloConfig = {
    baseSeed: 3000,
    runs: SMALL_RUNS,
    params: DEFAULT_PARAMS,
    intervention: { interventionId: "late-join-ok" },
  };

  it("runs off and on with the same baseSeed/runs/params/intervention, paired by seed", () => {
    const comparison = compareSpeechEffects(config);

    expect(comparison.off.config.baseSeed).toBe(config.baseSeed);
    expect(comparison.on.config.baseSeed).toBe(config.baseSeed);
    expect(comparison.off.runs.map((r) => r.seed)).toEqual(comparison.on.runs.map((r) => r.seed));
    expect(comparison.pairedSeeds).toEqual(comparison.off.runs.map((r) => r.seed));
  });

  it("is reproducible for the same input (same aggregate result and run order)", () => {
    const a = compareSpeechEffects(config);
    const b = compareSpeechEffects(config);

    expect(a).toEqual(b);
  });

  it("does not mutate config.params", () => {
    const params: SimParams = { ...DEFAULT_PARAMS };
    const snapshot = { ...params };

    compareSpeechEffects({ baseSeed: 5, runs: SMALL_RUNS, params, intervention: { interventionId: "late-join-ok" } });

    expect(params).toEqual(snapshot);
  });

  it("computes delta as on - off for rate and count metrics", () => {
    const comparison = compareSpeechEffects(config);

    expect(comparison.metrics.observerJoinerJoinRate.delta).toBeCloseTo(
      comparison.on.summary.observerJoinerJoinRate - comparison.off.summary.observerJoinerJoinRate,
    );
    expect(comparison.phase3Metrics.transitionInfluencedRate.delta).toBeCloseTo(
      comparison.on.speechEffectsSummary.transitionInfluencedRate -
        comparison.off.speechEffectsSummary.transitionInfluencedRate,
    );
  });

  it("keeps every Phase 3 off-side metric at zero (nothing to turn on) since Phase 3 effects never fire when disabled", () => {
    const comparison = compareSpeechEffects(config);

    expect(comparison.phase3Metrics.observerJoinerHeardSpeechRate.baseline).toBe(0);
    expect(comparison.phase3Metrics.interpretationOrEffectRate.baseline).toBe(0);
    expect(comparison.phase3Metrics.transitionInfluencedRate.baseline).toBe(0);
    for (const dimension of Object.values(comparison.phase3Metrics.dimensionTotals)) {
      expect(dimension.baseline).toBe(0);
    }
  });

  it("produces an all-zero diff for both existing and Phase 3 metrics when no speech can ever occur (maxTicks: 0)", () => {
    const comparison = compareSpeechEffects({ ...config, maxTicks: 0 });

    expect(comparison.metrics.observerJoinerJoinRate.delta).toBe(0);
    expect(comparison.metrics.observerJoinerLeaveRate.delta).toBe(0);
    expect(comparison.metrics.groupFailureRate.delta).toBe(0);
    expect(comparison.metrics.lateJoinSuccessRate.delta).toBe(0);
    expect(comparison.metrics.averageJoinedCount.delta).toBe(0);
    expect(comparison.metrics.averageLeftCount.delta).toBe(0);

    expect(comparison.phase3Metrics.observerJoinerHeardSpeechRate.delta).toBe(0);
    expect(comparison.phase3Metrics.interpretationOrEffectRate.delta).toBe(0);
    expect(comparison.phase3Metrics.transitionInfluencedRate.delta).toBe(0);
    for (const dimension of Object.values(comparison.phase3Metrics.dimensionTotals)) {
      expect(dimension.delta).toBe(0);
    }
  });

  it("shows a non-zero interpretationOrEffectRate on the 'on' side for a preset that reliably produces speech", () => {
    const preset = getPresetById("natural");

    const comparison = compareSpeechEffects({ baseSeed: 9000, runs: 20, params: preset.params });

    expect(comparison.on.speechEffectsSummary.interpretationOrEffectRate).toBeGreaterThan(0);
  });
});
