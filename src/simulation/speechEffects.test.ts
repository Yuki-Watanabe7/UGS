import { describe, expect, it } from "vitest";
import { createSpeechEvent, DEFAULT_SPEECH_RANGE } from "./speech";
import type { SpeechEvent } from "./speech";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./model";
import {
  activeEffectStrengthAtTick,
  advanceActiveSpeechEffects,
  aggregateActiveEffects,
  DEFAULT_SPEECH_EFFECTS_CONFIG,
  deriveSpeechActiveEffects,
  deriveSpeechEffects,
  deriveSpeechInterpretations,
  deriveSpeechReceptions,
  registerActiveSpeechEffects,
  resolveSpeechEffectsConfig,
  sumActiveEffectValue,
} from "./speechEffects";
import type {
  SpeechActiveEffect,
  SpeechEffectsConfig,
  SpeechInterpreterCandidate,
  SpeechReceiverCandidate,
} from "./speechEffects";

const ENABLED: SpeechEffectsConfig = { enabled: true };
const DISABLED: SpeechEffectsConfig = { enabled: false };

function makeCandidate(overrides: Partial<SpeechReceiverCandidate>): SpeechReceiverCandidate {
  return { id: "agent-x", x: 0, y: 0, state: "undecided", ...overrides };
}

function makeInterpreter(overrides: Partial<SpeechInterpreterCandidate>): SpeechInterpreterCandidate {
  return {
    id: "agent-x",
    conformity: 0.5,
    influenceAvoidance: 0.5,
    cliqueId: undefined,
    stress: 0,
    state: "undecided",
    ...overrides,
  };
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
  const inviteTargeted = createSpeechEvent({
    tick: 3,
    speakerId: "founder",
    intent: "invite",
    reason: "lightObserverInvitation",
    target: "a",
    originX: 0,
    originY: 0,
  });
  const greet = createSpeechEvent({
    tick: 3,
    speakerId: "joiner",
    intent: "greet",
    reason: "joinGreeting",
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

  /** invite/decline1件を1受け手(id: "a")について解釈するまでの共通セットアップ */
  function interpretOne(
    speech: SpeechEvent,
    receiver: Partial<SpeechInterpreterCandidate>,
    existingTieStrength = 0.5,
  ) {
    const speakerId = speech.speakerId;
    const receptions = deriveSpeechReceptions(
      [speech],
      [makeCandidate({ id: speakerId }), makeCandidate({ id: "a", x: 10, y: 0 })],
      ENABLED,
    );
    const participants = [makeInterpreter({ id: speakerId }), makeInterpreter({ id: "a", ...receiver })];
    const interpretations = deriveSpeechInterpretations(receptions, [speech], participants, existingTieStrength, ENABLED);
    expect(interpretations).toHaveLength(1);
    return interpretations[0];
  }

  it("returns an empty array when disabled", () => {
    const receptions = deriveSpeechReceptions([invite], [makeCandidate({ id: "founder" }), makeCandidate({ id: "a", x: 10, y: 0 })], ENABLED);
    const participants = [makeInterpreter({ id: "founder" }), makeInterpreter({ id: "a" })];
    expect(deriveSpeechInterpretations(receptions, [invite], participants, 0.5, DISABLED)).toEqual([]);
  });

  it("skips receptions that were not heard (out of range), even though a matching SpeechEvent exists", () => {
    const farReceptions = deriveSpeechReceptions(
      [invite],
      [makeCandidate({ id: "founder" }), makeCandidate({ id: "far", x: DEFAULT_SPEECH_RANGE + 100, y: 0 })],
      ENABLED,
    );
    expect(farReceptions[0].heard).toBe(false);

    const participants = [makeInterpreter({ id: "founder" }), makeInterpreter({ id: "far" })];
    expect(deriveSpeechInterpretations(farReceptions, [invite], participants, 0.5, ENABLED)).toEqual([]);
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
    expect(deriveSpeechInterpretations([orphanReception], [], [makeInterpreter({ id: "a" })], 0.5, ENABLED)).toEqual([]);
  });

  it("skips receptions whose speaker/receiver is not found among participants (defensive, should not throw)", () => {
    const receptions = deriveSpeechReceptions(
      [invite],
      [makeCandidate({ id: "founder" }), makeCandidate({ id: "a", x: 10, y: 0 })],
      ENABLED,
    );
    expect(deriveSpeechInterpretations(receptions, [invite], [], 0.5, ENABLED)).toEqual([]);
  });

  describe("table-driven: intent x receiver traits x relation", () => {
    it("invite carries a positive valence for a receptive (high-conformity, low-avoidance) undecided receiver", () => {
      const interpretation = interpretOne(invite, { conformity: 0.9, influenceAvoidance: 0.1, stress: 0, state: "undecided" });
      expect(interpretation).toMatchObject({ intent: "invite", relation: "audience", valence: "positive" });
      expect(interpretation.intensity).toBeGreaterThan(0);
      expect(interpretation.intensity).toBeLessThanOrEqual(1);
    });

    it("welcome and invite share the same base magnitude, greet is deliberately weaker (social-cue reinforcement, not an invitation)", () => {
      const welcome = createSpeechEvent({
        tick: 3,
        speakerId: "founder",
        intent: "welcome",
        reason: "approachWelcome",
        target: "a",
        originX: 0,
        originY: 0,
      });
      const receiver = { conformity: 0.5, influenceAvoidance: 0.5, stress: 0, state: "undecided" as const };
      const inviteIntensity = interpretOne(invite, receiver).intensity;
      const welcomeIntensity = interpretOne({ ...welcome, target: undefined, audience: "nearby" }, receiver).intensity;
      const greetIntensity = interpretOne(greet, receiver).intensity;

      expect(welcomeIntensity).toBeCloseTo(inviteIntensity, 5);
      expect(greetIntensity).toBeGreaterThan(0);
      expect(greetIntensity).toBeLessThan(inviteIntensity);
    });

    it("decline carries a negative valence, lowering the target circle's attractiveness direction", () => {
      const interpretation = interpretOne(decline, { conformity: 0.5, influenceAvoidance: 0.5, stress: 0, state: "undecided" });
      expect(interpretation.valence).toBe("negative");
      expect(interpretation.intensity).toBeGreaterThan(0);
    });

    it("higher influenceAvoidance dampens the interpreted intensity", () => {
      const low = interpretOne(invite, { influenceAvoidance: 0.1 });
      const high = interpretOne(invite, { influenceAvoidance: 0.9 });
      expect(high.intensity).toBeLessThan(low.intensity);
    });

    it("influenceAvoidance dampens a targeted speech more than an equivalent nearby (audience) one", () => {
      const targetHigh = interpretOne(inviteTargeted, { influenceAvoidance: 0.9 });
      const audienceHigh = interpretOne(invite, { influenceAvoidance: 0.9 });
      expect(targetHigh.relation).toBe("target");
      expect(audienceHigh.relation).toBe("audience");
      // both start from the same base magnitude/relation weighting differences aside, the
      // avoidance penalty itself should bite harder for the personally-addressed (target) case.
      const targetAvoidanceFactor = targetHigh.factors.find((f) => f.key === "influenceAvoidance")?.contribution;
      const audienceAvoidanceFactor = audienceHigh.factors.find((f) => f.key === "influenceAvoidance")?.contribution;
      expect(targetAvoidanceFactor).toBeLessThan(audienceAvoidanceFactor ?? 1);
    });

    it("a targeted (target) speech is interpreted more strongly than the same speech heard as nearby audience", () => {
      const targeted = interpretOne(inviteTargeted, { conformity: 0.5, influenceAvoidance: 0.5, stress: 0, state: "undecided" });
      const audience = interpretOne(invite, { conformity: 0.5, influenceAvoidance: 0.5, stress: 0, state: "undecided" });
      expect(targeted.intensity).toBeGreaterThan(audience.intensity);
    });

    it("same-clique receivers trust the speaker more than out-of-clique receivers, given strong existing ties", () => {
      const receptions = deriveSpeechReceptions(
        [invite],
        [makeCandidate({ id: "founder" }), makeCandidate({ id: "a", x: 10, y: 0 })],
        ENABLED,
      );
      const sameInterpretation = deriveSpeechInterpretations(
        receptions,
        [invite],
        [makeInterpreter({ id: "founder", cliqueId: 1 }), makeInterpreter({ id: "a", cliqueId: 1 })],
        0.9,
        ENABLED,
      )[0];
      const diffInterpretation = deriveSpeechInterpretations(
        receptions,
        [invite],
        [makeInterpreter({ id: "founder", cliqueId: 1 }), makeInterpreter({ id: "a", cliqueId: 2 })],
        0.9,
        ENABLED,
      )[0];
      expect(sameInterpretation.intensity).toBeGreaterThan(diffInterpretation.intensity);
      const sameTrust = sameInterpretation.factors.find((f) => f.key === "relationshipTrust")?.contribution ?? 0;
      const diffTrust = diffInterpretation.factors.find((f) => f.key === "relationshipTrust")?.contribution ?? 0;
      expect(sameTrust).toBeGreaterThan(diffTrust);
    });

    it("high stress amplifies a decline's negative intensity and dampens an invite's positive intensity", () => {
      const declineLowStress = interpretOne(decline, { stress: 0 });
      const declineHighStress = interpretOne(decline, { stress: 1 });
      expect(declineHighStress.intensity).toBeGreaterThan(declineLowStress.intensity);

      const inviteLowStress = interpretOne(invite, { stress: 0 });
      const inviteHighStress = interpretOne(invite, { stress: 1 });
      expect(inviteHighStress.intensity).toBeLessThan(inviteLowStress.intensity);
    });

    it("a receiver already 'joined' is less affected than one still 'undecided'", () => {
      const undecidedInterpretation = interpretOne(invite, { state: "undecided" });
      const joinedInterpretation = interpretOne(invite, { state: "joined" });
      expect(joinedInterpretation.intensity).toBeLessThan(undecidedInterpretation.intensity);
    });

    it("stacking enough dampening factors rounds a nonzero base direction down to a neutral valence", () => {
      const interpretation = interpretOne(
        decline,
        { conformity: 0, influenceAvoidance: 1, stress: 0, state: "joined" },
        1,
      );
      expect(interpretation.valence).toBe("neutral");
      expect(interpretation.intensity).toBeLessThan(0.05);
    });

    it("clamps out-of-range personality/strength inputs to finite, in-range output (no NaN/Infinity)", () => {
      const wildSpeech: SpeechEvent = { ...invite, strength: Number.NaN, audibility: 500 };
      const interpretation = interpretOne(
        wildSpeech,
        { conformity: -5, influenceAvoidance: 10, stress: -3, state: "undecided" },
        5,
      );
      expect(Number.isFinite(interpretation.intensity)).toBe(true);
      expect(interpretation.intensity).toBeGreaterThanOrEqual(0);
      expect(interpretation.intensity).toBeLessThanOrEqual(1);
      for (const factor of interpretation.factors) {
        expect(Number.isFinite(factor.normalizedValue)).toBe(true);
        expect(Number.isFinite(factor.contribution)).toBe(true);
      }
    });

    it("is deterministic: identical inputs produce deep-equal interpretations", () => {
      const receiver = { conformity: 0.6, influenceAvoidance: 0.3, stress: 0.4, state: "approaching" as const };
      const first = interpretOne(invite, receiver, 0.7);
      const second = interpretOne(invite, receiver, 0.7);
      expect(second).toEqual(first);
    });

    it("carries an explanatory factor breakdown covering every documented input", () => {
      const interpretation = interpretOne(invite, { conformity: 0.6, influenceAvoidance: 0.3, stress: 0.2, state: "undecided" });
      const keys = interpretation.factors.map((f) => f.key);
      expect(keys).toEqual([
        "intentBase",
        "conformity",
        "influenceAvoidance",
        "relationshipTrust",
        "receiverStress",
        "receiverState",
        "receptionRelation",
        "strength",
      ]);
    });
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
    const participants = candidates.map((c) => makeInterpreter({ id: c.id, state: c.state }));
    const interpretations = deriveSpeechInterpretations(receptions, speechEvents, participants, 0.5, config);
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
      // Issue #96: invite is fixed to the approachProbability dimension (see INTENT_DIMENSION).
      dimension: "approachProbability",
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

describe("deriveSpeechEffects: per-intent dimension mapping (Issue #96)", () => {
  /** invite/welcome/greet/declineそれぞれ1件を1受け手(id: "a")について効果まで導出する共通セットアップ */
  function effectForIntent(speech: SpeechEvent) {
    const receptions = deriveSpeechReceptions(
      [speech],
      [makeCandidate({ id: speech.speakerId }), makeCandidate({ id: "a", x: 10, y: 0 })],
      ENABLED,
    );
    const participants = [
      makeInterpreter({ id: speech.speakerId }),
      makeInterpreter({ id: "a", conformity: 0.6, influenceAvoidance: 0.3, stress: 0.2, state: "undecided" }),
    ];
    const interpretations = deriveSpeechInterpretations(receptions, [speech], participants, 0.5, ENABLED);
    const effects = deriveSpeechEffects(interpretations, [speech], ENABLED);
    expect(effects).toHaveLength(1);
    return effects[0];
  }

  it.each([
    ["invite", "initiativeFormedCore", "audience", "approachProbability", "positive"],
    ["welcome", "approachWelcome", "target", "attractiveness", "positive"],
    ["greet", "joinGreeting", "audience", "stress", "positive"],
    ["decline", "leaveDeclaration", "audience", "leaveThreshold", "negative"],
  ] as const)(
    "%s (%s) is fixed to the %s dimension with a %s-valence-derived sign",
    (intent, reason, relationHint, dimension, valence) => {
      const speech = createSpeechEvent({
        tick: 5,
        speakerId: "speaker",
        intent,
        reason,
        ...(relationHint === "target" ? { target: "a" } : { audience: "nearby" as const }),
        originX: 0,
        originY: 0,
      });
      const effect = effectForIntent(speech);
      expect(effect.dimension).toBe(dimension);
      // stress dimension has an inverted sign relative to valence (positive news lowers the stress
      // accumulation rate, i.e. a negative outputValue); the other 3 dimensions keep valence's sign.
      if (dimension === "stress") {
        expect(effect.outputValue).toBeLessThan(0);
      } else if (valence === "positive") {
        expect(effect.outputValue).toBeGreaterThan(0);
      } else {
        expect(effect.outputValue).toBeLessThan(0);
      }
    },
  );

  it("produces no effect at all for a neutral-valence interpretation (dampened below the neutral threshold)", () => {
    const decline = createSpeechEvent({
      tick: 5,
      speakerId: "speaker",
      intent: "decline",
      reason: "leaveDeclaration",
      audience: "nearby",
      originX: 0,
      originY: 0,
    });
    const receptions = deriveSpeechReceptions(
      [decline],
      [makeCandidate({ id: "speaker" }), makeCandidate({ id: "a", x: 10, y: 0 })],
      ENABLED,
    );
    // conformity: 0, influenceAvoidance: 1, state: "joined" stacks enough dampening factors to round
    // the interpretation down to "neutral" (see the equivalent case in deriveSpeechInterpretations above).
    const participants = [
      makeInterpreter({ id: "speaker" }),
      makeInterpreter({ id: "a", conformity: 0, influenceAvoidance: 1, stress: 0, state: "joined" }),
    ];
    const interpretations = deriveSpeechInterpretations(receptions, [decline], participants, 1, ENABLED);
    expect(interpretations[0].valence).toBe("neutral");
    expect(deriveSpeechEffects(interpretations, [decline], ENABLED)).toEqual([]);
  });
});

describe("SpeechActiveEffect: decay and application (Issue #96)", () => {
  function makeActiveEffect(overrides: Partial<SpeechActiveEffect> = {}): SpeechActiveEffect {
    return {
      id: "active-effect-1",
      speechEffectEventId: "effect-1",
      speechEventId: "speech-1",
      speakerId: "speaker",
      intent: "greet",
      receiverId: "a",
      dimension: "stress",
      startedAtTick: 10,
      expiresAtTick: 16,
      initialStrength: -0.06,
      currentStrength: -0.06,
      decay: "linear",
      ...overrides,
    };
  }

  describe("activeEffectStrengthAtTick", () => {
    it("returns the full initialStrength at startedAtTick", () => {
      const effect = makeActiveEffect();
      expect(activeEffectStrengthAtTick(effect, 10)).toBe(-0.06);
    });

    it("decays linearly toward 0 as tick approaches expiresAtTick", () => {
      const effect = makeActiveEffect();
      // Halfway through the 6-tick span (10 -> 16), half the strength should remain.
      expect(activeEffectStrengthAtTick(effect, 13)).toBeCloseTo(-0.03, 10);
    });

    it("returns exactly 0 at and after expiresAtTick", () => {
      const effect = makeActiveEffect();
      expect(activeEffectStrengthAtTick(effect, 16)).toBe(0);
      expect(activeEffectStrengthAtTick(effect, 100)).toBe(0);
    });

    it("is a deterministic, tick-only computation (no rng involved, identical inputs produce identical output)", () => {
      const effect = makeActiveEffect();
      expect(activeEffectStrengthAtTick(effect, 12)).toBe(activeEffectStrengthAtTick(effect, 12));
    });
  });

  describe("advanceActiveSpeechEffects", () => {
    it("drops effects whose expiresAtTick has been reached, keeping the rest with an updated currentStrength", () => {
      const stillActive = makeActiveEffect({ id: "still-active" });
      const expired = makeActiveEffect({ id: "expired", startedAtTick: 0, expiresAtTick: 5 });
      const advanced = advanceActiveSpeechEffects([stillActive, expired], 12);

      expect(advanced.map((e) => e.id)).toEqual(["still-active"]);
      expect(advanced[0].currentStrength).toBeCloseTo(activeEffectStrengthAtTick(stillActive, 12), 10);
    });

    it("returns an empty array when given an empty array", () => {
      expect(advanceActiveSpeechEffects([], 5)).toEqual([]);
    });
  });

  describe("sumActiveEffectValue", () => {
    it("sums only effects matching receiverId and dimension, ignoring the rest", () => {
      const effects: SpeechActiveEffect[] = [
        makeActiveEffect({
          id: "e1",
          speechEventId: "speech-e1",
          speakerId: "speaker-1",
          receiverId: "a",
          dimension: "stress",
          initialStrength: -0.02,
        }),
        makeActiveEffect({
          id: "e2",
          speechEventId: "speech-e2",
          speakerId: "speaker-2",
          receiverId: "a",
          dimension: "stress",
          initialStrength: -0.01,
        }),
        makeActiveEffect({ id: "e3", speechEventId: "speech-e3", receiverId: "b", dimension: "stress", initialStrength: -0.5 }),
        makeActiveEffect({ id: "e4", speechEventId: "speech-e4", receiverId: "a", dimension: "leaveThreshold", initialStrength: 0.5 }),
      ];
      // At startedAtTick (10), full initialStrength applies: -0.02 + -0.01 = -0.03
      expect(sumActiveEffectValue(effects, "a", "stress", 10)).toBeCloseTo(-0.03, 10);
    });

    it("for the attractiveness dimension, only sums effects whose targetGroupId matches the given group", () => {
      const effects: SpeechActiveEffect[] = [
        makeActiveEffect({
          id: "e1",
          speechEventId: "speech-e1",
          dimension: "attractiveness",
          targetGroupId: "group-1",
          initialStrength: 0.3,
        }),
        makeActiveEffect({
          id: "e2",
          speechEventId: "speech-e2",
          dimension: "attractiveness",
          targetGroupId: "group-2",
          initialStrength: 0.4,
        }),
      ];
      expect(sumActiveEffectValue(effects, "a", "attractiveness", 10, "group-1")).toBeCloseTo(0.3, 10);
      expect(sumActiveEffectValue(effects, "a", "attractiveness", 10, "group-2")).toBeCloseTo(0.4, 10);
      expect(sumActiveEffectValue(effects, "a", "attractiveness", 10, "group-3")).toBe(0);
    });

    it("returns 0 when no effects match", () => {
      expect(sumActiveEffectValue([], "a", "stress", 10)).toBe(0);
    });
  });

  describe("deriveSpeechActiveEffects", () => {
    const baseEffect = {
      id: "effect-1",
      speechEventId: "speech-1",
      interpretationEventId: "interpretation-1",
      receiverId: "a",
      speakerId: "speaker",
      intent: "invite" as const,
      reason: "initiativeFormedCore" as const,
      occurredTick: 4,
      appliedTick: 4,
      outputValue: 0.2,
      durationTicks: 5,
    };

    it("returns an empty array when disabled", () => {
      const effects = [{ ...baseEffect, dimension: "approachProbability" as const }];
      expect(deriveSpeechActiveEffects(effects, [makeInterpreter({ id: "a" })], DISABLED)).toEqual([]);
    });

    it("produces exactly one SpeechActiveEffect per SpeechEffectEvent, carrying start/expire/initial/current strength", () => {
      const effects = [{ ...baseEffect, dimension: "approachProbability" as const }];
      const active = deriveSpeechActiveEffects(effects, [makeInterpreter({ id: "a" })], ENABLED);

      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({
        speechEffectEventId: "effect-1",
        receiverId: "a",
        dimension: "approachProbability",
        startedAtTick: 4,
        expiresAtTick: 9,
        initialStrength: 0.2,
        currentStrength: 0.2,
        decay: "linear",
        targetGroupId: undefined,
      });
    });

    it("for the attractiveness dimension, sets targetGroupId from the receiver's joinedGroupId snapshot", () => {
      const effects = [{ ...baseEffect, dimension: "attractiveness" as const }];
      const active = deriveSpeechActiveEffects(
        effects,
        [makeInterpreter({ id: "a", joinedGroupId: "group-42" })],
        ENABLED,
      );
      expect(active[0].targetGroupId).toBe("group-42");
    });

    it("leaves targetGroupId undefined for non-attractiveness dimensions even if the receiver has a joinedGroupId", () => {
      const effects = [{ ...baseEffect, dimension: "stress" as const }];
      const active = deriveSpeechActiveEffects(
        effects,
        [makeInterpreter({ id: "a", joinedGroupId: "group-42" })],
        ENABLED,
      );
      expect(active[0].targetGroupId).toBeUndefined();
    });
  });
});

describe("Issue #96 integration: single speech, single receiver, end-to-end from SpeechEvent to applied active effect", () => {
  it("traces a single 'invite' speech through reception -> interpretation -> effect -> active effect, staying linked by id and decaying deterministically", () => {
    const speech = createSpeechEvent({
      tick: 10,
      speakerId: "founder",
      intent: "invite",
      reason: "initiativeFormedCore",
      audience: "nearby",
      originX: 0,
      originY: 0,
    });

    // 1. 認知
    const receptions = deriveSpeechReceptions(
      [speech],
      [makeCandidate({ id: "founder" }), makeCandidate({ id: "receiver", x: 10, y: 0 })],
      ENABLED,
    );
    expect(receptions).toHaveLength(1);

    // 2. 解釈
    const participants: SpeechInterpreterCandidate[] = [
      makeInterpreter({ id: "founder" }),
      makeInterpreter({ id: "receiver", conformity: 0.8, influenceAvoidance: 0.2, stress: 0.1, state: "undecided" }),
    ];
    const interpretations = deriveSpeechInterpretations(receptions, [speech], participants, 0.5, ENABLED);
    expect(interpretations).toHaveLength(1);
    expect(interpretations[0].valence).toBe("positive");

    // 3. 効果登録(構造化記録)
    const effects = deriveSpeechEffects(interpretations, [speech], ENABLED);
    expect(effects).toHaveLength(1);
    expect(effects[0].dimension).toBe("approachProbability");
    expect(effects[0].outputValue).toBeGreaterThan(0);

    // 4. active effect生成(実際に判断式へ適用されうる持続効果)
    const activeEffects = deriveSpeechActiveEffects(effects, participants, ENABLED);
    expect(activeEffects).toHaveLength(1);
    const active = activeEffects[0];

    // id連鎖: active -> effect -> interpretation -> reception -> speech まで、全段が一意に遡れる
    expect(active.speechEffectEventId).toBe(effects[0].id);
    expect(effects[0].interpretationEventId).toBe(interpretations[0].id);
    expect(interpretations[0].receptionEventId).toBe(receptions[0].id);
    expect(interpretations[0].speechEventId).toBe(speech.id);
    expect(active.receiverId).toBe("receiver");
    expect(active.initialStrength).toBe(effects[0].outputValue);
    expect(active.currentStrength).toBe(active.initialStrength);
    expect(active.startedAtTick).toBe(10);
    expect(active.expiresAtTick).toBe(10 + effects[0].durationTicks);
    expect(active.decay).toBe("linear");

    // 5. 参照: 発言直後(startedAtTick)ではフル強度、期間の途中では線形に減衰、期限切れ後は0
    expect(sumActiveEffectValue(activeEffects, "receiver", "approachProbability", active.startedAtTick)).toBe(
      active.initialStrength,
    );
    const midTick = Math.round((active.startedAtTick + active.expiresAtTick) / 2);
    const midValue = sumActiveEffectValue(activeEffects, "receiver", "approachProbability", midTick);
    expect(midValue).toBeGreaterThan(0);
    expect(midValue).toBeLessThan(active.initialStrength);
    expect(sumActiveEffectValue(activeEffects, "receiver", "approachProbability", active.expiresAtTick)).toBe(0);

    // 6. 期限切れ効果の破棄: expiresAtTick以降はadvanceActiveSpeechEffectsで取り除かれる
    expect(advanceActiveSpeechEffects(activeEffects, active.expiresAtTick)).toEqual([]);
    expect(advanceActiveSpeechEffects(activeEffects, active.startedAtTick + 1)).toHaveLength(1);

    // 7. 他の受け手・他の次元には一切影響しない(このtickでは"receiver"以外の参加者は存在しないが、
    //    dimension/receiverIdのどちらかが一致しなければ加算されないことを明示的に確認する)
    expect(sumActiveEffectValue(activeEffects, "receiver", "stress", active.startedAtTick)).toBe(0);
    expect(sumActiveEffectValue(activeEffects, "someone-else", "approachProbability", active.startedAtTick)).toBe(0);
  });
});

describe("aggregateActiveEffects (Issue #97: 複数発言の競合・累積・更新・上限制御)", () => {
  function makeActive(overrides: Partial<SpeechActiveEffect> = {}): SpeechActiveEffect {
    return {
      id: "active-1",
      speechEffectEventId: "effect-1",
      speechEventId: "speech-1",
      speakerId: "speaker-1",
      intent: "invite",
      receiverId: "a",
      dimension: "approachProbability",
      startedAtTick: 10,
      expiresAtTick: 20,
      initialStrength: 0.1,
      currentStrength: 0.1,
      decay: "linear",
      ...overrides,
    };
  }

  it("returns value 0 and empty contributions when nothing matches", () => {
    const result = aggregateActiveEffects([], "a", "stress", 10);
    expect(result).toMatchObject({ value: 0, rawNetValue: 0 });
    expect(result.positiveContributions).toEqual([]);
    expect(result.negativeContributions).toEqual([]);
    expect(result.duplicateContributions).toEqual([]);
  });

  it("caps same-direction accumulation at DIMENSION_EFFECT_LIMIT (3x the dimension's base magnitude) instead of summing without bound", () => {
    // approachProbability base magnitude is 0.25, so the limit is 0.75; three distinct 0.5 contributions
    // would sum to 1.5 without a cap.
    const effects = [
      makeActive({ id: "e1", speechEventId: "speech-1", initialStrength: 0.5 }),
      makeActive({ id: "e2", speechEventId: "speech-2", initialStrength: 0.5 }),
      makeActive({ id: "e3", speechEventId: "speech-3", initialStrength: 0.5 }),
    ];
    const result = aggregateActiveEffects(effects, "a", "approachProbability", 10);
    expect(result.positiveContributions).toHaveLength(3);
    expect(result.value).toBeCloseTo(0.75, 10);
    expect(result.rawNetValue).toBeCloseTo(0.75, 10);
  });

  it("caps same-direction negative accumulation symmetrically", () => {
    // leaveThreshold base magnitude is 0.15, so the limit is 0.45; two distinct -0.5 contributions
    // would sum to -1.0 without a cap.
    const effects = [
      makeActive({ id: "e1", speechEventId: "speech-1", dimension: "leaveThreshold", initialStrength: -0.5 }),
      makeActive({ id: "e2", speechEventId: "speech-2", dimension: "leaveThreshold", initialStrength: -0.5 }),
    ];
    const result = aggregateActiveEffects(effects, "a", "leaveThreshold", 10);
    expect(result.negativeContributions).toHaveLength(2);
    expect(result.value).toBeCloseTo(-0.45, 10);
  });

  it("nets opposite-direction contributions while keeping both sides individually traceable", () => {
    const effects = [
      makeActive({ id: "e1", speechEventId: "speech-1", dimension: "stress", initialStrength: 0.05 }),
      makeActive({ id: "e2", speechEventId: "speech-2", dimension: "stress", initialStrength: -0.07 }),
    ];
    const result = aggregateActiveEffects(effects, "a", "stress", 10);
    expect(result.value).toBeCloseTo(-0.02, 10);
    expect(result.positiveContributions.map((c) => c.speechEventId)).toEqual(["speech-1"]);
    expect(result.negativeContributions.map((c) => c.speechEventId)).toEqual(["speech-2"]);
  });

  it("forbids double-applying the same speechEventId, keeping only the first contribution in stable order", () => {
    const effects = [
      makeActive({ id: "dup-b", speechEventId: "speech-dup", startedAtTick: 10, initialStrength: 0.2 }),
      makeActive({ id: "dup-a", speechEventId: "speech-dup", startedAtTick: 10, initialStrength: 0.4 }),
    ];
    const result = aggregateActiveEffects(effects, "a", "approachProbability", 10);
    // compareActiveEffectOrder ties on (startedAtTick, speechEventId) here, so "dup-a" < "dup-b" by id wins.
    expect(result.positiveContributions).toHaveLength(1);
    expect(result.positiveContributions[0].speechActiveEffectId).toBe("dup-a");
    expect(result.duplicateContributions).toHaveLength(1);
    expect(result.duplicateContributions[0].speechActiveEffectId).toBe("dup-b");
    expect(result.value).toBeCloseTo(0.4, 10);
  });

  it("clamps a single extreme contribution to the dimension's safe range", () => {
    const effects = [makeActive({ dimension: "attractiveness", targetGroupId: "g1", initialStrength: 100 })];
    const result = aggregateActiveEffects(effects, "a", "attractiveness", 10, "g1");
    expect(result.value).toBeCloseTo(1.05, 10); // attractiveness limit: 0.35 * 3
  });

  it("is independent of the input array's order (reversal invariant)", () => {
    const effects = [
      makeActive({ id: "e1", speechEventId: "speech-1", dimension: "stress", initialStrength: 0.02 }),
      makeActive({ id: "e2", speechEventId: "speech-2", dimension: "stress", initialStrength: -0.03 }),
      makeActive({ id: "e3", speechEventId: "speech-3", dimension: "stress", initialStrength: 0.04 }),
      makeActive({ id: "e4", speechEventId: "speech-4", dimension: "stress", initialStrength: -0.01 }),
    ];
    const forward = aggregateActiveEffects(effects, "a", "stress", 10);
    const reversed = aggregateActiveEffects([...effects].reverse(), "a", "stress", 10);
    expect(reversed).toEqual(forward);
  });
});

describe("registerActiveSpeechEffects (Issue #97: 同一話者・同一intentの再発言は置換/更新として扱う)", () => {
  function makeActive(overrides: Partial<SpeechActiveEffect> = {}): SpeechActiveEffect {
    return {
      id: "active-1",
      speechEffectEventId: "effect-1",
      speechEventId: "speech-1",
      speakerId: "speaker-1",
      intent: "invite",
      receiverId: "a",
      dimension: "approachProbability",
      startedAtTick: 10,
      expiresAtTick: 20,
      initialStrength: 0.1,
      currentStrength: 0.1,
      decay: "linear",
      ...overrides,
    };
  }

  it("appends a new effect when no existing effect shares receiver+dimension+speaker+intent", () => {
    const existing = [makeActive({ id: "old", speakerId: "speaker-1" })];
    const incoming = [makeActive({ id: "new", speakerId: "speaker-2", speechEventId: "speech-2" })];
    const result = registerActiveSpeechEffects(existing, incoming);
    expect(result.map((e) => e.id)).toEqual(["old", "new"]);
  });

  it("replaces (does not stack) an existing effect from the same speaker+intent+receiver+dimension", () => {
    const existing = [makeActive({ id: "old", initialStrength: 0.1 })];
    const incoming = [makeActive({ id: "new", speechEventId: "speech-2", initialStrength: 0.2 })];
    const result = registerActiveSpeechEffects(existing, incoming);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("new");
  });

  it("does not replace an effect from a different speaker", () => {
    const existing = [makeActive({ id: "old", speakerId: "speaker-1" })];
    const incoming = [makeActive({ id: "new", speakerId: "speaker-2", speechEventId: "speech-2" })];
    const result = registerActiveSpeechEffects(existing, incoming);
    expect(result.map((e) => e.id)).toEqual(["old", "new"]);
  });

  it("does not replace an effect from the same speaker but a different intent", () => {
    const existing = [makeActive({ id: "old", intent: "invite" })];
    const incoming = [makeActive({ id: "new", intent: "greet", speechEventId: "speech-2" })];
    const result = registerActiveSpeechEffects(existing, incoming);
    expect(result.map((e) => e.id)).toEqual(["old", "new"]);
  });

  it("for the attractiveness dimension, only replaces when targetGroupId also matches", () => {
    const existing = [
      makeActive({ id: "old", dimension: "attractiveness", targetGroupId: "group-1", initialStrength: 0.2 }),
    ];
    const differentGroup = [
      makeActive({
        id: "new-group",
        dimension: "attractiveness",
        targetGroupId: "group-2",
        speechEventId: "speech-2",
        initialStrength: 0.3,
      }),
    ];
    const sameGroup = [
      makeActive({
        id: "new-same-group",
        dimension: "attractiveness",
        targetGroupId: "group-1",
        speechEventId: "speech-3",
        initialStrength: 0.4,
      }),
    ];

    const afterDifferentGroup = registerActiveSpeechEffects(existing, differentGroup);
    expect(afterDifferentGroup.map((e) => e.id)).toEqual(["old", "new-group"]);

    const afterSameGroup = registerActiveSpeechEffects(existing, sameGroup);
    expect(afterSameGroup.map((e) => e.id)).toEqual(["new-same-group"]);
  });

  it("is independent of the incoming array's order (reversal invariant)", () => {
    const existing: SpeechActiveEffect[] = [];
    const incoming = [
      makeActive({ id: "e1", speakerId: "speaker-1", speechEventId: "speech-1", startedAtTick: 10 }),
      makeActive({ id: "e2", speakerId: "speaker-2", speechEventId: "speech-2", startedAtTick: 11 }),
      makeActive({ id: "e3", speakerId: "speaker-3", speechEventId: "speech-3", startedAtTick: 9 }),
    ];
    const forward = registerActiveSpeechEffects(existing, incoming);
    const reversed = registerActiveSpeechEffects(existing, [...incoming].reverse());
    expect(reversed).toEqual(forward);
    // Stable order (startedAtTick -> speechEventId -> ...) puts e3 (tick 9) before e1 (tick 10) before e2 (tick 11).
    expect(forward.map((e) => e.id)).toEqual(["e3", "e1", "e2"]);
  });
});
