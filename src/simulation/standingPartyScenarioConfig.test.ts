import { describe, expect, it } from "vitest";
import {
  DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
  INTIMATE_STANDING_PARTY_CONFIG,
  NETWORKING_STANDING_PARTY_CONFIG,
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
