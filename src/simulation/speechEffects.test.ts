import { describe, expect, it } from "vitest";
import { createSpeechEvent } from "./speech";
import type { SpeechEvent } from "./speech";
import {
  DEFAULT_SPEECH_EFFECTS_CONFIG,
  deriveSpeechEffects,
  deriveSpeechInterpretations,
  deriveSpeechReceptions,
  resolveSpeechEffectsConfig,
} from "./speechEffects";
import type { SpeechEffectsConfig } from "./speechEffects";

const ENABLED: SpeechEffectsConfig = { enabled: true };
const DISABLED: SpeechEffectsConfig = { enabled: false };

describe("resolveSpeechEffectsConfig", () => {
  it("defaults to disabled when no config is given (backward compatible with pre-Phase-3 callers)", () => {
    expect(resolveSpeechEffectsConfig()).toEqual(DEFAULT_SPEECH_EFFECTS_CONFIG);
    expect(resolveSpeechEffectsConfig().enabled).toBe(false);
  });

  it("merges a partial override onto the default", () => {
    expect(resolveSpeechEffectsConfig({ enabled: true })).toEqual({ enabled: true });
  });
});

describe("deriveSpeechReceptions", () => {
  const targeted = createSpeechEvent({
    tick: 7,
    speakerId: "helper",
    intent: "invite",
    reason: "lightObserverInvitation",
    target: "observer",
  });
  const broadcast = createSpeechEvent({
    tick: 9,
    speakerId: "founder",
    intent: "invite",
    reason: "initiativeFormedCore",
    audience: "nearby",
  });

  it("returns an empty array when disabled, regardless of input", () => {
    expect(deriveSpeechReceptions([targeted, broadcast], ["helper", "observer", "founder"], DISABLED)).toEqual([]);
  });

  it("produces exactly one reception for a targeted SpeechEvent, addressed to the target only", () => {
    const receptions = deriveSpeechReceptions([targeted], ["helper", "observer", "bystander"], ENABLED);

    expect(receptions).toHaveLength(1);
    expect(receptions[0]).toMatchObject({
      speechEventId: targeted.id,
      tick: 7,
      receiverId: "observer",
      relation: "target",
      heard: true,
    });
  });

  it("produces one reception per receiver (excluding the speaker) for an audience: nearby SpeechEvent", () => {
    const receptions = deriveSpeechReceptions([broadcast], ["founder", "a", "b"], ENABLED);

    expect(receptions).toHaveLength(2);
    expect(receptions.map((r) => r.receiverId)).toEqual(["a", "b"]);
    for (const reception of receptions) {
      expect(reception.relation).toBe("audience");
      expect(reception.speechEventId).toBe(broadcast.id);
    }
  });

  it("produces deterministic, unique ids across multiple SpeechEvents", () => {
    const receptions = deriveSpeechReceptions([targeted, broadcast], ["helper", "observer", "founder", "a"], ENABLED);
    const ids = receptions.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);

    const again = deriveSpeechReceptions([targeted, broadcast], ["helper", "observer", "founder", "a"], ENABLED);
    expect(again).toEqual(receptions);
  });
});

describe("deriveSpeechInterpretations", () => {
  const invite = createSpeechEvent({
    tick: 3,
    speakerId: "founder",
    intent: "invite",
    reason: "initiativeFormedCore",
    audience: "nearby",
  });
  const decline = createSpeechEvent({
    tick: 4,
    speakerId: "leaver",
    intent: "decline",
    reason: "leaveDeclaration",
    audience: "nearby",
  });

  it("returns an empty array when disabled", () => {
    const receptions = deriveSpeechReceptions([invite], ["founder", "a"], ENABLED);
    expect(deriveSpeechInterpretations(receptions, [invite], DISABLED)).toEqual([]);
  });

  it("derives valence purely from the SpeechEvent's intent (no personality/relationship input)", () => {
    const receptions = [...deriveSpeechReceptions([invite], ["founder", "a"], ENABLED)];
    const interpretations = deriveSpeechInterpretations(receptions, [invite], ENABLED);

    expect(interpretations).toHaveLength(1);
    expect(interpretations[0]).toMatchObject({
      speechEventId: invite.id,
      receptionEventId: receptions[0].id,
      receiverId: "a",
      inputFactors: { intent: "invite" },
      valence: "positive",
    });
  });

  it("maps decline to a neutral valence", () => {
    const receptions = deriveSpeechReceptions([decline], ["leaver", "a"], ENABLED);
    const interpretations = deriveSpeechInterpretations(receptions, [decline], ENABLED);

    expect(interpretations[0].valence).toBe("neutral");
  });

  it("skips receptions whose speechEventId is not found in the provided speechEvents (defensive, should not throw)", () => {
    const orphanReception = {
      id: "reception-missing-a",
      speechEventId: "missing",
      tick: 1,
      receiverId: "a",
      relation: "audience" as const,
      heard: true,
    };
    expect(deriveSpeechInterpretations([orphanReception], [], ENABLED)).toEqual([]);
  });
});

describe("deriveSpeechEffects", () => {
  const invite = createSpeechEvent({
    tick: 3,
    speakerId: "founder",
    intent: "invite",
    reason: "initiativeFormedCore",
    audience: "nearby",
  });

  function pipeline(speechEvents: SpeechEvent[], receiverIds: string[], config: SpeechEffectsConfig) {
    const receptions = deriveSpeechReceptions(speechEvents, receiverIds, config);
    const interpretations = deriveSpeechInterpretations(receptions, speechEvents, config);
    const effects = deriveSpeechEffects(interpretations, speechEvents, config);
    return { receptions, interpretations, effects };
  }

  it("returns an empty array when disabled", () => {
    const { interpretations } = pipeline([invite], ["founder", "a"], ENABLED);
    expect(deriveSpeechEffects(interpretations, [invite], DISABLED)).toEqual([]);
  });

  it("produces a structured effect record linked back to speechEventId/interpretationEventId, without mutating anything", () => {
    const { interpretations, effects } = pipeline([invite], ["founder", "a"], ENABLED);

    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      speechEventId: invite.id,
      interpretationEventId: interpretations[0].id,
      receiverId: "a",
      reason: "initiativeFormedCore",
      occurredTick: 3,
      appliedTick: 3,
      dimension: "stress",
    });
    expect(typeof effects[0].outputValue).toBe("number");
    expect(typeof effects[0].durationTicks).toBe("number");
  });

  it("end-to-end: speechEventId/receiverId stay consistent across all three stages for a single speech", () => {
    const { receptions, interpretations, effects } = pipeline([invite], ["founder", "a", "b"], ENABLED);

    expect(receptions).toHaveLength(2);
    expect(interpretations).toHaveLength(2);
    expect(effects).toHaveLength(2);

    for (const receiverId of ["a", "b"]) {
      const reception = receptions.find((r) => r.receiverId === receiverId);
      const interpretation = interpretations.find((i) => i.receiverId === receiverId);
      const effect = effects.find((e) => e.receiverId === receiverId);

      expect(reception).toBeDefined();
      expect(interpretation).toBeDefined();
      expect(effect).toBeDefined();
      expect(interpretation?.speechEventId).toBe(invite.id);
      expect(interpretation?.receptionEventId).toBe(reception?.id);
      expect(effect?.speechEventId).toBe(invite.id);
      expect(effect?.interpretationEventId).toBe(interpretation?.id);
    }
  });

  it("is a pure function: identical inputs produce deep-equal outputs", () => {
    const { interpretations } = pipeline([invite], ["founder", "a"], ENABLED);
    const first = deriveSpeechEffects(interpretations, [invite], ENABLED);
    const second = deriveSpeechEffects(interpretations, [invite], ENABLED);
    expect(first).toEqual(second);
  });
});
