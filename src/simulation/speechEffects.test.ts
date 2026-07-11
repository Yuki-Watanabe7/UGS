import { describe, expect, it } from "vitest";
import { createSpeechEvent, DEFAULT_SPEECH_RANGE } from "./speech";
import type { SpeechEvent } from "./speech";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./model";
import {
  DEFAULT_SPEECH_EFFECTS_CONFIG,
  deriveSpeechEffects,
  deriveSpeechInterpretations,
  deriveSpeechReceptions,
  resolveSpeechEffectsConfig,
} from "./speechEffects";
import type { SpeechEffectsConfig, SpeechReceiverCandidate } from "./speechEffects";

const ENABLED: SpeechEffectsConfig = { enabled: true };
const DISABLED: SpeechEffectsConfig = { enabled: false };

function makeCandidate(overrides: Partial<SpeechReceiverCandidate>): SpeechReceiverCandidate {
  return { id: "agent-x", x: 0, y: 0, state: "undecided", ...overrides };
}

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
    originX: 0,
    originY: 0,
  });
  const broadcast = createSpeechEvent({
    tick: 9,
    speakerId: "founder",
    intent: "invite",
    reason: "initiativeFormedCore",
    audience: "nearby",
    originX: 0,
    originY: 0,
  });

  it("returns an empty array when disabled, regardless of input", () => {
    const candidates = [
      makeCandidate({ id: "helper" }),
      makeCandidate({ id: "observer", x: 500, y: 300 }),
      makeCandidate({ id: "founder" }),
    ];
    expect(deriveSpeechReceptions([targeted, broadcast], candidates, DISABLED)).toEqual([]);
  });

  it("produces exactly one reception for a targeted SpeechEvent, addressed to the target only", () => {
    // lightObserverInvitation uses a deliberately large default range, so a distant target is still heard.
    const candidates = [
      makeCandidate({ id: "helper" }),
      makeCandidate({ id: "observer", x: 500, y: 300 }),
      makeCandidate({ id: "bystander", x: 10, y: 10 }),
    ];
    const receptions = deriveSpeechReceptions([targeted], candidates, ENABLED);

    expect(receptions).toHaveLength(1);
    expect(receptions[0]).toMatchObject({
      speechEventId: targeted.id,
      tick: 7,
      receiverId: "observer",
      relation: "target",
      heard: true,
      reason: "withinRange",
    });
    expect(receptions[0].distance).toBeCloseTo(Math.hypot(500, 300));
    expect(receptions[0].threshold).toBe(targeted.audibility);
  });

  it("produces one reception per eligible receiver (excluding the speaker) for an audience: nearby SpeechEvent", () => {
    const candidates = [
      makeCandidate({ id: "founder" }),
      makeCandidate({ id: "a", x: 50, y: 50 }),
      makeCandidate({ id: "b", x: 150, y: 0 }),
    ];
    const receptions = deriveSpeechReceptions([broadcast], candidates, ENABLED);

    expect(receptions).toHaveLength(2);
    expect(receptions.map((r) => r.receiverId)).toEqual(["a", "b"]);
    for (const reception of receptions) {
      expect(reception.relation).toBe("audience");
      expect(reception.speechEventId).toBe(broadcast.id);
      expect(reception.heard).toBe(true);
      expect(reception.reason).toBe("withinRange");
    }
  });

  it("produces deterministic, unique ids across multiple SpeechEvents", () => {
    const candidates = [
      makeCandidate({ id: "helper" }),
      makeCandidate({ id: "observer", x: 500, y: 300 }),
      makeCandidate({ id: "founder" }),
      makeCandidate({ id: "a", x: 50, y: 50 }),
    ];
    const receptions = deriveSpeechReceptions([targeted, broadcast], candidates, ENABLED);
    const ids = receptions.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);

    const again = deriveSpeechReceptions([targeted, broadcast], candidates, ENABLED);
    expect(again).toEqual(receptions);
  });

  it("excludes a candidate in the 'left' state from audience broadcasts, even if physically nearby", () => {
    const candidates = [
      makeCandidate({ id: "founder" }),
      makeCandidate({ id: "gone", x: 10, y: 0, state: "left" }),
      makeCandidate({ id: "a", x: 50, y: 50 }),
    ];
    const receptions = deriveSpeechReceptions([broadcast], candidates, ENABLED);

    expect(receptions.map((r) => r.receiverId)).toEqual(["a"]);
  });

  it("generates no reception at all when the targeted SpeechEvent's target is absent from the candidate list", () => {
    const candidates = [makeCandidate({ id: "helper" }), makeCandidate({ id: "bystander", x: 10, y: 10 })];
    expect(deriveSpeechReceptions([targeted], candidates, ENABLED)).toEqual([]);
  });

  it("generates no reception when the targeted SpeechEvent's target has already left", () => {
    const candidates = [makeCandidate({ id: "helper" }), makeCandidate({ id: "observer", x: 5, y: 5, state: "left" })];
    expect(deriveSpeechReceptions([targeted], candidates, ENABLED)).toEqual([]);
  });

  it("returns heard: false with reason 'outOfRange' for an audience candidate beyond the audibility threshold, while still recording distance/threshold", () => {
    const farAway = makeCandidate({ id: "far", x: DEFAULT_SPEECH_RANGE + 50, y: 0 });
    const candidates = [makeCandidate({ id: "founder" }), farAway];
    const receptions = deriveSpeechReceptions([broadcast], candidates, ENABLED);

    expect(receptions).toHaveLength(1);
    expect(receptions[0]).toMatchObject({
      receiverId: "far",
      relation: "audience",
      heard: false,
      reason: "outOfRange",
      threshold: broadcast.audibility,
    });
    expect(receptions[0].distance).toBeCloseTo(DEFAULT_SPEECH_RANGE + 50);
  });

  it("distance boundary: a candidate exactly at the audibility threshold is heard (inclusive)", () => {
    const speech = createSpeechEvent({
      tick: 1,
      speakerId: "speaker",
      intent: "invite",
      reason: "initiativeFormedCore",
      audience: "nearby",
      originX: 0,
      originY: 0,
      range: 100,
      strength: 1,
    });
    const atThreshold = makeCandidate({ id: "at-threshold", x: 100, y: 0 });
    const receptions = deriveSpeechReceptions([speech], [makeCandidate({ id: "speaker" }), atThreshold], ENABLED);

    expect(receptions).toHaveLength(1);
    expect(receptions[0].distance).toBe(100);
    expect(receptions[0].heard).toBe(true);
    expect(receptions[0].reason).toBe("withinRange");
  });

  it("distance boundary: a candidate just beyond the audibility threshold is not heard", () => {
    const speech = createSpeechEvent({
      tick: 1,
      speakerId: "speaker",
      intent: "invite",
      reason: "initiativeFormedCore",
      audience: "nearby",
      originX: 0,
      originY: 0,
      range: 100,
      strength: 1,
    });
    const justBeyond = makeCandidate({ id: "just-beyond", x: 100.01, y: 0 });
    const receptions = deriveSpeechReceptions([speech], [makeCandidate({ id: "speaker" }), justBeyond], ENABLED);

    expect(receptions).toHaveLength(1);
    expect(receptions[0].heard).toBe(false);
    expect(receptions[0].reason).toBe("outOfRange");
  });

  it("canvas edges: a speech at one corner of the world and a receiver at the opposite corner compute a real, finite distance", () => {
    const speech = createSpeechEvent({
      tick: 1,
      speakerId: "corner-speaker",
      intent: "invite",
      reason: "initiativeFormedCore",
      audience: "nearby",
      originX: 0,
      originY: 0,
    });
    const oppositeCorner = makeCandidate({ id: "opposite", x: WORLD_WIDTH, y: WORLD_HEIGHT });
    const receptions = deriveSpeechReceptions(
      [speech],
      [makeCandidate({ id: "corner-speaker" }), oppositeCorner],
      ENABLED,
    );

    expect(receptions).toHaveLength(1);
    expect(receptions[0].distance).toBeCloseTo(Math.hypot(WORLD_WIDTH, WORLD_HEIGHT));
    // Default range is far smaller than the world diagonal, so the opposite corner is out of range.
    expect(receptions[0].heard).toBe(false);
  });

  it("same position: a receiver standing exactly where the speech originated is always heard (distance 0)", () => {
    const speech = createSpeechEvent({
      tick: 1,
      speakerId: "speaker",
      intent: "invite",
      reason: "initiativeFormedCore",
      audience: "nearby",
      originX: 400,
      originY: 260,
    });
    const sameSpot = makeCandidate({ id: "co-located", x: 400, y: 260 });
    const receptions = deriveSpeechReceptions([speech], [makeCandidate({ id: "speaker" }), sameSpot], ENABLED);

    expect(receptions).toHaveLength(1);
    expect(receptions[0].distance).toBe(0);
    expect(receptions[0].heard).toBe(true);
  });
});

describe("deriveSpeechInterpretations", () => {
  const invite = createSpeechEvent({
    tick: 3,
    speakerId: "founder",
    intent: "invite",
    reason: "initiativeFormedCore",
    audience: "nearby",
    originX: 0,
    originY: 0,
  });
  const decline = createSpeechEvent({
    tick: 4,
    speakerId: "leaver",
    intent: "decline",
    reason: "leaveDeclaration",
    audience: "nearby",
    originX: 0,
    originY: 0,
  });

  it("returns an empty array when disabled", () => {
    const receptions = deriveSpeechReceptions([invite], [makeCandidate({ id: "founder" }), makeCandidate({ id: "a", x: 10, y: 0 })], ENABLED);
    expect(deriveSpeechInterpretations(receptions, [invite], DISABLED)).toEqual([]);
  });

  it("derives valence purely from the SpeechEvent's intent (no personality/relationship input)", () => {
    const receptions = deriveSpeechReceptions(
      [invite],
      [makeCandidate({ id: "founder" }), makeCandidate({ id: "a", x: 10, y: 0 })],
      ENABLED,
    );
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
    const receptions = deriveSpeechReceptions(
      [decline],
      [makeCandidate({ id: "leaver" }), makeCandidate({ id: "a", x: 10, y: 0 })],
      ENABLED,
    );
    const interpretations = deriveSpeechInterpretations(receptions, [decline], ENABLED);

    expect(interpretations[0].valence).toBe("neutral");
  });

  it("skips receptions that were not heard (out of range), even though a matching SpeechEvent exists", () => {
    const farReceptions = deriveSpeechReceptions(
      [invite],
      [makeCandidate({ id: "founder" }), makeCandidate({ id: "far", x: DEFAULT_SPEECH_RANGE + 100, y: 0 })],
      ENABLED,
    );
    expect(farReceptions[0].heard).toBe(false);

    expect(deriveSpeechInterpretations(farReceptions, [invite], ENABLED)).toEqual([]);
  });

  it("skips receptions whose speechEventId is not found in the provided speechEvents (defensive, should not throw)", () => {
    const orphanReception = {
      id: "reception-missing-a",
      speechEventId: "missing",
      tick: 1,
      receiverId: "a",
      relation: "audience" as const,
      distance: 0,
      threshold: 200,
      heard: true,
      reason: "withinRange" as const,
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
    originX: 0,
    originY: 0,
  });

  function pipeline(speechEvents: SpeechEvent[], candidates: SpeechReceiverCandidate[], config: SpeechEffectsConfig) {
    const receptions = deriveSpeechReceptions(speechEvents, candidates, config);
    const interpretations = deriveSpeechInterpretations(receptions, speechEvents, config);
    const effects = deriveSpeechEffects(interpretations, speechEvents, config);
    return { receptions, interpretations, effects };
  }

  it("returns an empty array when disabled", () => {
    const { interpretations } = pipeline(
      [invite],
      [makeCandidate({ id: "founder" }), makeCandidate({ id: "a", x: 10, y: 0 })],
      ENABLED,
    );
    expect(deriveSpeechEffects(interpretations, [invite], DISABLED)).toEqual([]);
  });

  it("produces a structured effect record linked back to speechEventId/interpretationEventId, without mutating anything", () => {
    const { interpretations, effects } = pipeline(
      [invite],
      [makeCandidate({ id: "founder" }), makeCandidate({ id: "a", x: 10, y: 0 })],
      ENABLED,
    );

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
    const { receptions, interpretations, effects } = pipeline(
      [invite],
      [makeCandidate({ id: "founder" }), makeCandidate({ id: "a", x: 10, y: 0 }), makeCandidate({ id: "b", x: -10, y: 0 })],
      ENABLED,
    );

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
    const { interpretations } = pipeline(
      [invite],
      [makeCandidate({ id: "founder" }), makeCandidate({ id: "a", x: 10, y: 0 })],
      ENABLED,
    );
    const first = deriveSpeechEffects(interpretations, [invite], ENABLED);
    const second = deriveSpeechEffects(interpretations, [invite], ENABLED);
    expect(first).toEqual(second);
  });
});
