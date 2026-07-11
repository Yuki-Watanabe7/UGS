import { describe, expect, it } from "vitest";
import { buildAgentLabelMap } from "./speechDisplay";
import {
  formatActiveEffectStatusLine,
  formatAggregatedEffectSummary,
  formatContributionLine,
  formatEffectLine,
  formatInterpretationFactorLine,
  formatInterpretationLine,
  formatReceptionLine,
  speechEffectDimensionLabel,
  speechInterpretationFactorLabel,
  speechInterpretationValenceLabel,
} from "./speechEffectsDisplay";
import type {
  AggregatedActiveEffect,
  SpeechEffectEvent,
  SpeechInterpretationEvent,
  SpeechReceptionEvent,
} from "../simulation/speechEffects";
import type { Agent } from "../simulation/types";

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-x",
    label: "X",
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    willingness: 0.5,
    initiative: 0.5,
    ambiguityTolerance: 0.5,
    influenceAvoidance: 0.5,
    conformity: 0.5,
    leaveThreshold: 0.5,
    isObserverJoiner: false,
    state: "undecided",
    stress: 0,
    ...overrides,
  };
}

const labelById = buildAgentLabelMap([
  makeAgent({ id: "observer", label: "Dさん" }),
  makeAgent({ id: "helper", label: "Cさん" }),
]);

describe("speechEffectDimensionLabel / speechInterpretationValenceLabel / speechInterpretationFactorLabel", () => {
  it("maps every SpeechEffectDimension to a Japanese label", () => {
    expect(speechEffectDimensionLabel("stress")).toBe("ストレス蓄積率");
    expect(speechEffectDimensionLabel("attractiveness")).toBe("輪の魅力度");
    expect(speechEffectDimensionLabel("approachProbability")).toBe("接近確率");
    expect(speechEffectDimensionLabel("leaveThreshold")).toBe("離脱しきい値");
  });

  it("maps every SpeechInterpretationValence to a Japanese label", () => {
    expect(speechInterpretationValenceLabel("positive")).toBe("好意的");
    expect(speechInterpretationValenceLabel("neutral")).toContain("中立");
    expect(speechInterpretationValenceLabel("negative")).toBe("否定的");
  });

  it("maps every factor key to a Japanese label", () => {
    expect(speechInterpretationFactorLabel("conformity")).toBe("同調傾向");
    expect(speechInterpretationFactorLabel("influenceAvoidance")).toBe("影響回避度");
  });
});

describe("formatReceptionLine", () => {
  it("describes a heard reception with distance and threshold", () => {
    const reception: SpeechReceptionEvent = {
      id: "reception-1",
      speechEventId: "speech-1",
      tick: 5,
      receiverId: "observer",
      relation: "target",
      distance: 12.34,
      threshold: 200,
      heard: true,
      reason: "withinRange",
    };

    const line = formatReceptionLine(reception, labelById);

    expect(line).toContain("Dさん");
    expect(line).toContain("届いた");
    expect(line).not.toContain("届かなかった");
    expect(line).toContain("12.3");
  });

  it("describes an out-of-range reception distinctly from a heard one", () => {
    const reception: SpeechReceptionEvent = {
      id: "reception-2",
      speechEventId: "speech-1",
      tick: 5,
      receiverId: "observer",
      relation: "audience",
      distance: 400,
      threshold: 200,
      heard: false,
      reason: "outOfRange",
    };

    const line = formatReceptionLine(reception, labelById);

    expect(line).toContain("届かなかった");
    expect(line).toContain("圏外");
  });
});

describe("formatInterpretationLine / formatInterpretationFactorLine", () => {
  const interpretation: SpeechInterpretationEvent = {
    id: "interpretation-1",
    speechEventId: "speech-1",
    receptionEventId: "reception-1",
    tick: 5,
    receiverId: "observer",
    intent: "invite",
    relation: "target",
    valence: "positive",
    intensity: 0.5,
    factors: [{ key: "conformity", rawValue: 0.5, normalizedValue: 0.5, contribution: 0.75 }],
  };

  it("summarizes the receiver, valence, and intensity", () => {
    const line = formatInterpretationLine(interpretation, labelById);

    expect(line).toContain("Dさん");
    expect(line).toContain("好意的");
    expect(line).toContain("50%");
  });

  it("formats a single factor's raw value and contribution", () => {
    const line = formatInterpretationFactorLine(interpretation.factors[0]);

    expect(line).toContain("同調傾向");
    expect(line).toContain("0.50");
    expect(line).toContain("0.75");
  });
});

describe("formatEffectLine", () => {
  it("describes the dimension, signed value, and duration", () => {
    const effect: SpeechEffectEvent = {
      id: "effect-1",
      speechEventId: "speech-1",
      interpretationEventId: "interpretation-1",
      receiverId: "observer",
      speakerId: "helper",
      intent: "invite",
      reason: "lightObserverInvitation",
      occurredTick: 5,
      appliedTick: 5,
      dimension: "approachProbability",
      outputValue: 0.2,
      durationTicks: 5,
    };

    const line = formatEffectLine(effect, labelById);

    expect(line).toContain("Dさん");
    expect(line).toContain("接近確率");
    expect(line).toContain("+0.200");
    expect(line).toContain("持続5tick");
  });
});

describe("formatActiveEffectStatusLine", () => {
  it("reports current/initial strength and remaining ticks when still active", () => {
    const line = formatActiveEffectStatusLine({
      initialStrength: 0.2,
      currentStrength: 0.1,
      startedAtTick: 5,
      expiresAtTick: 10,
      remainingTicks: 3,
    });

    expect(line).toContain("+0.100");
    expect(line).toContain("+0.200");
    expect(line).toContain("残り3tick");
  });

  it("reports expiry/replacement when no active status remains", () => {
    const line = formatActiveEffectStatusLine(undefined);

    expect(line).toContain("現在は作用していない");
  });
});

describe("formatAggregatedEffectSummary / formatContributionLine", () => {
  it("includes the target group id only when set", () => {
    const withTarget: AggregatedActiveEffect = {
      receiverId: "observer",
      dimension: "attractiveness",
      targetGroupId: "group-1",
      tick: 4,
      value: 0.3,
      rawNetValue: 0.3,
      positiveContributions: [],
      negativeContributions: [],
      duplicateContributions: [],
    };
    const withoutTarget: AggregatedActiveEffect = { ...withTarget, targetGroupId: undefined };

    expect(formatAggregatedEffectSummary(withTarget)).toContain("group-1");
    expect(formatAggregatedEffectSummary(withoutTarget)).not.toContain("対象輪");
  });

  it("formats a contribution's speechEventId, speaker, intent, and value", () => {
    const line = formatContributionLine(
      { speechActiveEffectId: "active-1", speechEffectEventId: "effect-1", speechEventId: "speech-1", speakerId: "helper", intent: "invite", value: 0.2 },
      labelById,
    );

    expect(line).toContain("speech-1");
    expect(line).toContain("Cさん");
    expect(line).toContain("invite");
    expect(line).toContain("+0.200");
  });
});
