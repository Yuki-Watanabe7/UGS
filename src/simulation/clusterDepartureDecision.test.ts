import { describe, expect, it } from "vitest";
import {
  computeClusterDepartureDecision,
  DEFAULT_CLUSTER_DEPARTURE_DECISION_CONFIG,
  validateClusterDepartureDecisionConfig,
  type ClusterDepartureDecisionConfig,
} from "./clusterDepartureDecision";

/**
 * Issue #188 (Phase 2): `computeClusterDepartureDecision`(責務9の心理モデル本体)の
 * 定性的性質を検証する。`docs/conversation-satisfaction-model.md`4節・issue「定性的性質・単体テスト」節
 * に列挙された各性質に1:1対応させる。
 */

const CONFIG = DEFAULT_CLUSTER_DEPARTURE_DECISION_CONFIG;

function decide(overrides: {
  ticksInCluster: number;
  conversationSatisfaction: number;
  socialCirculationTendency: number;
  config?: ClusterDepartureDecisionConfig;
}) {
  return computeClusterDepartureDecision({
    config: overrides.config ?? CONFIG,
    ticksInCluster: overrides.ticksInCluster,
    conversationSatisfaction: overrides.conversationSatisfaction,
    socialCirculationTendency: overrides.socialCirculationTendency,
  });
}

describe("validateClusterDepartureDecisionConfig", () => {
  it("accepts the default config", () => {
    expect(() => validateClusterDepartureDecisionConfig(CONFIG)).not.toThrow();
  });

  it("rejects a negative/non-integer minStayTicks", () => {
    expect(() => validateClusterDepartureDecisionConfig({ ...CONFIG, minStayTicks: -1 })).toThrow();
    expect(() => validateClusterDepartureDecisionConfig({ ...CONFIG, minStayTicks: 1.5 })).toThrow();
  });

  it("rejects satisfactionLeaveFloor <= 0 (would divide by zero)", () => {
    expect(() => validateClusterDepartureDecisionConfig({ ...CONFIG, satisfactionLeaveFloor: 0 })).toThrow();
    expect(() => validateClusterDepartureDecisionConfig({ ...CONFIG, satisfactionLeaveFloor: -0.1 })).toThrow();
  });

  it("rejects satisfactionLeaveFloor > 1, and contribution caps outside [0,1]", () => {
    expect(() => validateClusterDepartureDecisionConfig({ ...CONFIG, satisfactionLeaveFloor: 1.5 })).toThrow();
    expect(() => validateClusterDepartureDecisionConfig({ ...CONFIG, maxDissatisfactionContribution: 1.1 })).toThrow();
    expect(() => validateClusterDepartureDecisionConfig({ ...CONFIG, maxCirculationContribution: -0.1 })).toThrow();
  });

  it("rejects a non-positive circulationRampTicks (would divide by zero/flip direction)", () => {
    expect(() => validateClusterDepartureDecisionConfig({ ...CONFIG, circulationRampTicks: 0 })).toThrow();
    expect(() => validateClusterDepartureDecisionConfig({ ...CONFIG, circulationRampTicks: -5 })).toThrow();
  });

  it("rejects a negative circulationWarmupTicks or mixedReasonMargin", () => {
    expect(() => validateClusterDepartureDecisionConfig({ ...CONFIG, circulationWarmupTicks: -1 })).toThrow();
    expect(() => validateClusterDepartureDecisionConfig({ ...CONFIG, mixedReasonMargin: -0.01 })).toThrow();
  });
});

describe("computeClusterDepartureDecision: 最低滞在tick", () => {
  it("is ineligible with probability 0 strictly below minStayTicks, regardless of satisfaction/tendency", () => {
    for (const ticksInCluster of [0, 1, CONFIG.minStayTicks - 1]) {
      const decision = decide({ ticksInCluster, conversationSatisfaction: 0, socialCirculationTendency: 1 });
      expect(decision).toEqual({ eligible: false, probability: 0 });
    }
  });

  it("becomes eligible exactly at minStayTicks", () => {
    const decision = decide({ ticksInCluster: CONFIG.minStayTicks, conversationSatisfaction: 0, socialCirculationTendency: 0 });
    expect(decision.eligible).toBe(true);
  });
});

describe("computeClusterDepartureDecision: 満足度低下圧力", () => {
  it("is monotonically non-increasing in satisfaction (lower satisfaction never lowers the probability)", () => {
    const ticksInCluster = CONFIG.minStayTicks;
    let previousProbability = 1;
    for (const satisfaction of [0, 0.1, 0.25, 0.4, 0.5, 0.75, 1]) {
      const decision = decide({ ticksInCluster, conversationSatisfaction: satisfaction, socialCirculationTendency: 0 });
      expect(decision.probability).toBeLessThanOrEqual(previousProbability + 1e-9);
      previousProbability = decision.probability;
    }
  });

  it("contributes 0 once satisfaction reaches the leave floor (and above)", () => {
    const ticksInCluster = CONFIG.minStayTicks;
    for (const satisfaction of [CONFIG.satisfactionLeaveFloor, 0.75, 1]) {
      const decision = decide({ ticksInCluster, conversationSatisfaction: satisfaction, socialCirculationTendency: 0 });
      expect(decision.probability).toBe(0);
    }
  });

  it("never produces NaN/Infinity even at satisfaction 0", () => {
    const decision = decide({ ticksInCluster: CONFIG.minStayTicks, conversationSatisfaction: 0, socialCirculationTendency: 0 });
    expect(Number.isFinite(decision.probability)).toBe(true);
  });

  it("does not saturate probability to 1 from satisfaction alone at any stay duration", () => {
    for (const ticksInCluster of [CONFIG.minStayTicks, CONFIG.minStayTicks + 10_000]) {
      const decision = decide({ ticksInCluster, conversationSatisfaction: 0, socialCirculationTendency: 0 });
      expect(decision.probability).toBeLessThan(1);
    }
  });
});

describe("computeClusterDepartureDecision: 社交的回遊圧力", () => {
  it("is monotonically non-decreasing in socialCirculationTendency at fixed satisfaction/ticks", () => {
    const ticksInCluster = CONFIG.minStayTicks + CONFIG.circulationWarmupTicks + CONFIG.circulationRampTicks;
    let previousProbability = -1;
    for (const tendency of [0, 0.25, 0.5, 0.75, 1]) {
      const decision = decide({ ticksInCluster, conversationSatisfaction: 1, socialCirculationTendency: tendency });
      expect(decision.probability).toBeGreaterThanOrEqual(previousProbability - 1e-9);
      previousProbability = decision.probability;
    }
  });

  it("contributes exactly 0 when tendency is 0, regardless of how long the stay is", () => {
    for (const ticksInCluster of [CONFIG.minStayTicks, CONFIG.minStayTicks + 500]) {
      const decision = decide({ ticksInCluster, conversationSatisfaction: 1, socialCirculationTendency: 0 });
      expect(decision.probability).toBe(0);
    }
  });

  it("stays at 0 immediately after minStayTicks (does not spike right after joining) and rises smoothly afterwards", () => {
    const justEligible = decide({ ticksInCluster: CONFIG.minStayTicks, conversationSatisfaction: 1, socialCirculationTendency: 1 });
    expect(justEligible.probability).toBe(0);

    const midWarmup = decide({
      ticksInCluster: CONFIG.minStayTicks + Math.floor(CONFIG.circulationWarmupTicks / 2),
      conversationSatisfaction: 1,
      socialCirculationTendency: 1,
    });
    expect(midWarmup.probability).toBe(0);

    const midRamp = decide({
      ticksInCluster: CONFIG.minStayTicks + CONFIG.circulationWarmupTicks + Math.floor(CONFIG.circulationRampTicks / 2),
      conversationSatisfaction: 1,
      socialCirculationTendency: 1,
    });
    const fullRamp = decide({
      ticksInCluster: CONFIG.minStayTicks + CONFIG.circulationWarmupTicks + CONFIG.circulationRampTicks,
      conversationSatisfaction: 1,
      socialCirculationTendency: 1,
    });
    expect(midRamp.probability).toBeGreaterThan(0);
    expect(midRamp.probability).toBeLessThan(fullRamp.probability);
  });

  it("is monotonically non-decreasing in ticksInCluster once warmed up (does not drop back down)", () => {
    let previousProbability = 0;
    for (const extraTicks of [0, 5, 10, 15, 20, 25, 100]) {
      const decision = decide({
        ticksInCluster: CONFIG.minStayTicks + CONFIG.circulationWarmupTicks + extraTicks,
        conversationSatisfaction: 1,
        socialCirculationTendency: 0.6,
      });
      expect(decision.probability).toBeGreaterThanOrEqual(previousProbability - 1e-9);
      previousProbability = decision.probability;
    }
  });
});

describe("computeClusterDepartureDecision: 合成・受入条件", () => {
  it("produces probability 0 when both contributions are 0 (high satisfaction, zero tendency)", () => {
    const decision = decide({ ticksInCluster: CONFIG.minStayTicks + 500, conversationSatisfaction: 1, socialCirculationTendency: 0 });
    expect(decision).toEqual({ eligible: true, probability: 0 });
    expect(decision.factors).toBeUndefined();
    expect(decision.primaryReason).toBeUndefined();
  });

  it("keeps working from either factor alone when the other is 0 (independence)", () => {
    const satisfactionOnly = decide({ ticksInCluster: CONFIG.minStayTicks, conversationSatisfaction: 0, socialCirculationTendency: 0 });
    expect(satisfactionOnly.probability).toBeGreaterThan(0);
    expect(satisfactionOnly.primaryReason).toBe("lowConversationSatisfaction");

    const circulationOnly = decide({
      ticksInCluster: CONFIG.minStayTicks + CONFIG.circulationWarmupTicks + CONFIG.circulationRampTicks,
      conversationSatisfaction: 1,
      socialCirculationTendency: 1,
    });
    expect(circulationOnly.probability).toBeGreaterThan(0);
    expect(circulationOnly.primaryReason).toBe("socialCirculation");
  });

  it("keeps the final probability within [0,1] across a wide sweep of inputs", () => {
    for (const ticksInCluster of [0, CONFIG.minStayTicks, CONFIG.minStayTicks + 50, CONFIG.minStayTicks + 10_000]) {
      for (let satisfaction = 0; satisfaction <= 1; satisfaction += 0.25) {
        for (let tendency = 0; tendency <= 1; tendency += 0.25) {
          const decision = decide({ ticksInCluster, conversationSatisfaction: satisfaction, socialCirculationTendency: tendency });
          expect(decision.probability).toBeGreaterThanOrEqual(0);
          expect(decision.probability).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("reports primaryReason as mixed when both contributions are close, and it is deterministic across repeated calls", () => {
    // maxDissatisfactionContribution(0.08) ≈ maxCirculationContribution(0.06) at full ramp when
    // satisfaction is moderately low and tendency is high; tune ticks/satisfaction so the two
    // contributions land within mixedReasonMargin of each other.
    const ticksInCluster = CONFIG.minStayTicks + CONFIG.circulationWarmupTicks + CONFIG.circulationRampTicks;
    // circulation contribution at tendency=1, full ramp = maxCirculationContribution
    const circulationContribution = CONFIG.maxCirculationContribution;
    // pick satisfaction so dissatisfaction contribution matches circulationContribution:
    // contribution = maxDissatisfactionContribution * (floor - satisfaction) / floor
    const satisfaction =
      CONFIG.satisfactionLeaveFloor -
      (circulationContribution / CONFIG.maxDissatisfactionContribution) * CONFIG.satisfactionLeaveFloor;

    const first = decide({ ticksInCluster, conversationSatisfaction: satisfaction, socialCirculationTendency: 1 });
    const second = decide({ ticksInCluster, conversationSatisfaction: satisfaction, socialCirculationTendency: 1 });
    expect(first).toEqual(second);
    expect(first.primaryReason).toBe("mixedConversationAndSocialCirculation");
  });

  it("primaryReason is deterministic (same input -> same output) across the lowConversationSatisfaction/socialCirculation cases too", () => {
    const inputs = [
      { ticksInCluster: CONFIG.minStayTicks, conversationSatisfaction: 0.1, socialCirculationTendency: 0.05 },
      { ticksInCluster: CONFIG.minStayTicks + 200, conversationSatisfaction: 0.95, socialCirculationTendency: 0.9 },
    ];
    for (const input of inputs) {
      const a = decide(input);
      const b = decide(input);
      expect(a).toEqual(b);
    }
  });

  it("factors are sorted by contribution descending when both are present", () => {
    const decision = decide({
      ticksInCluster: CONFIG.minStayTicks + CONFIG.circulationWarmupTicks + CONFIG.circulationRampTicks,
      conversationSatisfaction: 0,
      socialCirculationTendency: 1,
    });
    expect(decision.factors).toBeDefined();
    if (decision.factors && decision.factors.length === 2) {
      expect(decision.factors[0].contribution).toBeGreaterThanOrEqual(decision.factors[1].contribution);
    }
  });

  it("coefficients are configurable via config (a custom config changes the resulting probability)", () => {
    const customConfig: ClusterDepartureDecisionConfig = {
      ...CONFIG,
      maxDissatisfactionContribution: 0.5,
    };
    const withDefault = decide({ ticksInCluster: CONFIG.minStayTicks, conversationSatisfaction: 0, socialCirculationTendency: 0 });
    const withCustom = decide({
      ticksInCluster: CONFIG.minStayTicks,
      conversationSatisfaction: 0,
      socialCirculationTendency: 0,
      config: customConfig,
    });
    expect(withCustom.probability).toBeGreaterThan(withDefault.probability);
  });
});
