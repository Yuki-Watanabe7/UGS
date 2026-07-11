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
import type { SpeechEffectsConfig, SpeechInterpreterCandidate, SpeechReceiverCandidate } from "./speechEffects";

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
