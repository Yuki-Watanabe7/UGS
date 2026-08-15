import { describe, expect, it } from "vitest";
import {
  DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
  INFO_RICH_STANDING_PARTY_CONFIG,
  INFO_SEEKING_STANDING_PARTY_CONFIG,
  INTIMATE_STANDING_PARTY_CONFIG,
  NETWORKING_STANDING_PARTY_CONFIG,
  RUMOR_MUTATION_STANDING_PARTY_CONFIG,
  TOPIC_SEGMENTED_STANDING_PARTY_CONFIG,
  validateStandingPartyScenarioConfig,
  type StandingPartyScenarioConfig,
} from "./standingPartyScenarioConfig";

/**
 * Issue #189 (Phase 2): standingParty専用のPhase 2設定束(会話満足度・クラスタ離脱判定・
 * 社交的回遊傾向分布)のdomain validationと、2つの比較プリセットの定性的な差を検証する。
 */

describe("validateStandingPartyScenarioConfig", () => {
  it("accepts the default config and both comparison presets", () => {
    expect(() => validateStandingPartyScenarioConfig(DEFAULT_STANDING_PARTY_SCENARIO_CONFIG)).not.toThrow();
    expect(() => validateStandingPartyScenarioConfig(NETWORKING_STANDING_PARTY_CONFIG)).not.toThrow();
    expect(() => validateStandingPartyScenarioConfig(INTIMATE_STANDING_PARTY_CONFIG)).not.toThrow();
  });

  it("rejects an out-of-range circulationTendencyRange", () => {
    const invalid: StandingPartyScenarioConfig = {
      ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
      circulationTendencyRange: { min: -0.1, max: 1 },
    };
    expect(() => validateStandingPartyScenarioConfig(invalid)).toThrow();
  });

  it("rejects circulationTendencyRange.min > max", () => {
    const invalid: StandingPartyScenarioConfig = {
      ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
      circulationTendencyRange: { min: 0.8, max: 0.2 },
    };
    expect(() => validateStandingPartyScenarioConfig(invalid)).toThrow();
  });

  it("rejects NaN/Infinity in circulationTendencyRange", () => {
    expect(() =>
      validateStandingPartyScenarioConfig({
        ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
        circulationTendencyRange: { min: Number.NaN, max: 1 },
      }),
    ).toThrow();
    expect(() =>
      validateStandingPartyScenarioConfig({
        ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
        circulationTendencyRange: { min: 0, max: Number.POSITIVE_INFINITY },
      }),
    ).toThrow();
  });

  it("still rejects an invalid nested conversationSatisfaction/clusterDeparture config", () => {
    expect(() =>
      validateStandingPartyScenarioConfig({
        ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
        conversationSatisfaction: {
          ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.conversationSatisfaction,
          satisfactionDecayPerTick: -1,
        },
      }),
    ).toThrow();
    expect(() =>
      validateStandingPartyScenarioConfig({
        ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
        clusterDeparture: { ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.clusterDeparture, minStayTicks: -1 },
      }),
    ).toThrow();
  });
});

describe("comparison preset intent (issue #189 要件2節)", () => {
  it("networking preset skews circulationTendencyRange higher than the default/intimate preset", () => {
    expect(NETWORKING_STANDING_PARTY_CONFIG.circulationTendencyRange.min).toBeGreaterThan(
      DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.circulationTendencyRange.min,
    );
    expect(NETWORKING_STANDING_PARTY_CONFIG.circulationTendencyRange.min).toBeGreaterThan(
      INTIMATE_STANDING_PARTY_CONFIG.circulationTendencyRange.max,
    );
  });

  it("intimate preset skews circulationTendencyRange lower and decays satisfaction slower", () => {
    expect(INTIMATE_STANDING_PARTY_CONFIG.circulationTendencyRange.max).toBeLessThan(
      DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.circulationTendencyRange.max,
    );
    expect(INTIMATE_STANDING_PARTY_CONFIG.conversationSatisfaction.satisfactionDecayPerTick).toBeLessThan(
      DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.conversationSatisfaction.satisfactionDecayPerTick,
    );
  });

  it("intimate preset requires a longer minimum stay than networking preset (要件: 最低滞在時間が長め/短め)", () => {
    expect(INTIMATE_STANDING_PARTY_CONFIG.clusterDeparture.minStayTicks).toBeGreaterThan(
      NETWORKING_STANDING_PARTY_CONFIG.clusterDeparture.minStayTicks,
    );
  });

  it("networking preset has a higher circulation-driven departure contribution than intimate", () => {
    expect(NETWORKING_STANDING_PARTY_CONFIG.clusterDeparture.maxCirculationContribution).toBeGreaterThan(
      INTIMATE_STANDING_PARTY_CONFIG.clusterDeparture.maxCirculationContribution,
    );
  });
});

describe("Issue #233 (Phase 5): topicIntegration field & comparison presets", () => {
  it("topicIntegration is disabled by default (Phase 4までの挙動を完全維持)", () => {
    expect(DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.topicIntegration.enabled).toBe(false);
  });

  it("all 4 existing Phase 2/3 presets keep topicIntegration disabled (meaning未変更、要件7節)", () => {
    for (const preset of [NETWORKING_STANDING_PARTY_CONFIG, INTIMATE_STANDING_PARTY_CONFIG]) {
      expect(preset.topicIntegration.enabled).toBe(false);
    }
  });

  it("accepts all 4 new Phase 5 comparison presets", () => {
    for (const preset of [
      INFO_RICH_STANDING_PARTY_CONFIG,
      TOPIC_SEGMENTED_STANDING_PARTY_CONFIG,
      RUMOR_MUTATION_STANDING_PARTY_CONFIG,
      INFO_SEEKING_STANDING_PARTY_CONFIG,
    ]) {
      expect(() => validateStandingPartyScenarioConfig(preset)).not.toThrow();
      expect(preset.informationPropagation.enabled).toBe(true);
      expect(preset.topicIntegration.enabled).toBe(true);
    }
  });

  it("情報が広がりやすい交流会: topic発話・採用・再伝達が既定より高い(要件7節)", () => {
    const base = DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.informationPropagation;
    expect(INFO_RICH_STANDING_PARTY_CONFIG.informationPropagation.contentUtterance.utteranceProbability).toBeGreaterThan(
      base.contentUtterance.utteranceProbability,
    );
    expect(INFO_RICH_STANDING_PARTY_CONFIG.informationPropagation.transmission.adoptionBaseRate).toBeGreaterThan(
      base.transmission.adoptionBaseRate,
    );
    expect(INFO_RICH_STANDING_PARTY_CONFIG.informationPropagation.retelling.mutationEnabled).toBe(true);
    expect(INFO_RICH_STANDING_PARTY_CONFIG.informationPropagation.retelling.retellingCooldownTicks).toBeLessThan(
      base.retelling.retellingCooldownTicks,
    );
  });

  it("輪ごとに話題が分かれる場: topic persistenceとinterest matchが既定より強い(要件7節)", () => {
    const base = DEFAULT_STANDING_PARTY_SCENARIO_CONFIG;
    expect(TOPIC_SEGMENTED_STANDING_PARTY_CONFIG.informationPropagation.contentUtterance.topicPersistence).toBeGreaterThan(
      base.informationPropagation.contentUtterance.topicPersistence,
    );
    expect(TOPIC_SEGMENTED_STANDING_PARTY_CONFIG.topicIntegration.compatibility.interestMatchWeight).toBeGreaterThan(
      base.topicIntegration.compatibility.interestMatchWeight,
    );
  });

  it("口コミが変容しやすい場: mutation率が既定より高いが上限制御(maxVariantsPerClaim等)は緩めない(要件7節)", () => {
    const base = DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.informationPropagation;
    expect(RUMOR_MUTATION_STANDING_PARTY_CONFIG.informationPropagation.retelling.mutationEnabled).toBe(true);
    expect(RUMOR_MUTATION_STANDING_PARTY_CONFIG.informationPropagation.retelling.baseMutationProbability).toBeGreaterThan(
      base.retelling.baseMutationProbability,
    );
    expect(RUMOR_MUTATION_STANDING_PARTY_CONFIG.informationPropagation.limits.maxVariantsPerClaim).toBe(
      base.limits.maxVariantsPerClaim,
    );
    expect(RUMOR_MUTATION_STANDING_PARTY_CONFIG.informationPropagation.retelling.semanticDistanceCeiling).toBe(
      base.retelling.semanticDistanceCeiling,
    );
  });

  it("情報探索型の参加者が多い場: informationSeekingWeightが既定より高く、transitionが有効(要件7節)", () => {
    const base = DEFAULT_STANDING_PARTY_SCENARIO_CONFIG;
    expect(INFO_SEEKING_STANDING_PARTY_CONFIG.topicIntegration.informationSeekingWeight).toBeGreaterThan(
      base.topicIntegration.informationSeekingWeight,
    );
    expect(INFO_SEEKING_STANDING_PARTY_CONFIG.transition.enabled).toBe(true);
  });
});
